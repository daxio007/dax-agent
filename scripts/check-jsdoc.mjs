import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const sourceRoot = path.resolve("src");
const requiredSections = ["使用方法", "作用"];

/**
 * 使用方法：传入目录路径，返回目录下所有 TypeScript 源文件的绝对路径。
 * 作用：为 JSDoc 审计提供稳定、递归的源码文件清单。
 * 边界：只收集 `.ts` 文件，不进入依赖或构建目录。
 * @param directory 要递归扫描的目录绝对路径。
 */
async function listTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTypeScriptFiles(target)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(target);
    }
  }
  return files;
}

/**
 * 使用方法：对 TypeScript AST 节点读取紧邻声明的 JSDoc 文本。
 * 作用：把一个或多个 JSDoc 块合并成可检查字符串。
 * 边界：普通行注释和非 JSDoc 块不会被视为方法文档。
 * @param node 需要读取 JSDoc 的 TypeScript AST 声明节点。
 */
function jsDocText(node) {
  return (node.jsDoc || []).map((doc) => doc.getText()).join("\n");
}

/**
 * 使用方法：传入函数、类方法或变量声明节点，返回适合错误报告的名称。
 * 作用：让审计输出能够准确指出缺少文档的方法。
 * 边界：无法解析名称时使用 `<anonymous>`。
 * @param node 需要生成错误报告名称的 TypeScript AST 声明节点。
 */
function declarationName(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (node.name && ts.isStringLiteral(node.name)) return node.name.text;
  if (ts.isConstructorDeclaration(node)) return "constructor";
  return "<anonymous>";
}

/**
 * 使用方法：遍历一个 SourceFile，收集所有需要 JSDoc 的命名方法声明。
 * 作用：覆盖函数声明、类方法、构造器、访问器，以及变量绑定的箭头函数。
 * 边界：map、filter、事件监听器等内联匿名回调不单独要求 JSDoc。
 * @param sourceFile 需要审计的 TypeScript 源文件 AST。
 */
function collectMethodDeclarations(sourceFile) {
  const declarations = [];
  const visit = (node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      declarations.push(node);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      declarations.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
}

/**
 * 使用方法：传入 collectMethodDeclarations() 返回的声明节点。
 * 作用：统一取得普通函数、类方法和变量箭头函数的形参节点。
 * 边界：没有参数的声明返回空数组。
 * @param node 需要读取形参的 TypeScript AST 声明节点。
 */
function declarationParameters(node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return [...node.initializer.parameters];
  }
  return node.parameters ? [...node.parameters] : [];
}

/**
 * 使用方法：传入形参节点和所属 SourceFile。
 * 作用：把标识符或绑定模式转换成可与 @param 标签匹配的名称。
 * 边界：复杂绑定模式使用源码文本作为名称，项目应优先使用具名输入对象。
 * @param parameter TypeScript 方法签名中的单个形参节点。
 * @param sourceFile 形参所属的 TypeScript 源文件 AST。
 */
function parameterName(parameter, sourceFile) {
  return parameter.name.getText(sourceFile);
}

/**
 * 使用方法：传入完整 JSDoc 文本，返回具有非空说明的参数名称集合。
 * 作用：区分“存在 @param 标签”和“参数用途确实有文字说明”。
 * 边界：支持普通名称和 `[name=default]` 写法，不解析嵌套属性标签。
 * @param documentation 要解析的完整 JSDoc 文本。
 */
function documentedParameterNames(documentation) {
  const names = new Set();
  for (const line of documentation.split(/\r?\n/)) {
    const match = line.match(
      /@param\s+(?:\{[^}]+\}\s*)?(\[[^\]]+\]|[A-Za-z_$][\w$]*)\s+(?:-\s*)?(.+?)\s*$/
    );
    if (!match?.[1] || !match[2]?.trim()) continue;
    const name = match[1].replace(/^\[/, "").replace(/\]$/, "").split("=")[0];
    if (name) names.add(name);
  }
  return names;
}

/**
 * 使用方法：检查单个 TypeScript 文件，返回缺失 JSDoc、必需章节或参数说明的方法列表。
 * 作用：统一验证“每个命名方法都有使用方法、作用和完整参数说明”的项目规则。
 * 边界：只做静态文档检查，不判断业务逻辑正确性。
 * @param filePath 需要读取并审计的 TypeScript 文件绝对路径。
 */
async function inspectFile(filePath) {
  const source = await readFile(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const failures = [];
  for (const declaration of collectMethodDeclarations(sourceFile)) {
    const documentation = jsDocText(declaration);
    const missingSections = requiredSections.filter(
      (section) => !documentation.includes(section)
    );
    const documentedParameters = documentedParameterNames(documentation);
    const missingParameters = declarationParameters(declaration)
      .map((parameter) => parameterName(parameter, sourceFile))
      .filter((name) => !documentedParameters.has(name));
    if (!documentation || missingSections.length || missingParameters.length) {
      const position = sourceFile.getLineAndCharacterOfPosition(
        declaration.getStart(sourceFile)
      );
      const missing = [];
      if (!documentation) {
        missing.push("JSDoc");
      } else {
        missing.push(...missingSections);
        missing.push(...missingParameters.map((name) => `@param ${name}`));
      }
      failures.push({
        file: path.relative(process.cwd(), filePath),
        line: position.line + 1,
        name: declarationName(declaration),
        missing: missing.join("、")
      });
    }
  }
  return failures;
}

/**
 * 使用方法：通过 `npm run check:jsdoc` 执行。
 * 作用：扫描整个 `src/`，发现无文档命名方法时以非零状态退出。
 * 边界：检查通过只代表文档结构完整，仍需配合 typecheck 和 build。
 */
async function main() {
  const files = await listTypeScriptFiles(sourceRoot);
  const failures = (
    await Promise.all(files.map((filePath) => inspectFile(filePath)))
  ).flat();
  if (failures.length) {
    console.error(`JSDoc check failed: ${failures.length} method(s) need documentation.`);
    for (const failure of failures) {
      console.error(
        `${failure.file}:${failure.line} ${failure.name} missing ${failure.missing}`
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log(`JSDoc check passed: ${files.length} TypeScript file(s) inspected.`);
}

await main();
