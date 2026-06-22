import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const sourceRoot = path.resolve("src");
const requiredSections = ["使用方法", "作用"];

/**
 * 使用方法：传入目录路径，返回目录下所有 TypeScript 源文件的绝对路径。
 * 作用：为 JSDoc 审计提供稳定、递归的源码文件清单。
 * 边界：只收集 `.ts` 文件，不进入依赖或构建目录。
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
 */
function jsDocText(node) {
  return (node.jsDoc || []).map((doc) => doc.getText()).join("\n");
}

/**
 * 使用方法：传入函数、类方法或变量声明节点，返回适合错误报告的名称。
 * 作用：让审计输出能够准确指出缺少文档的方法。
 * 边界：无法解析名称时使用 `<anonymous>`。
 */
function declarationName(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (node.name && ts.isStringLiteral(node.name)) return node.name.text;
  return "<anonymous>";
}

/**
 * 使用方法：遍历一个 SourceFile，收集所有需要 JSDoc 的命名方法声明。
 * 作用：覆盖函数声明、类方法、构造器、访问器，以及变量绑定的箭头函数。
 * 边界：map、filter、事件监听器等内联匿名回调不单独要求 JSDoc。
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
 * 使用方法：检查单个 TypeScript 文件，返回缺失 JSDoc 或必需章节的方法列表。
 * 作用：统一验证“每个命名方法都有使用方法和作用说明”的项目规则。
 * 边界：只做静态文档检查，不判断业务逻辑正确性。
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
    if (!documentation || missingSections.length) {
      const position = sourceFile.getLineAndCharacterOfPosition(
        declaration.getStart(sourceFile)
      );
      failures.push({
        file: path.relative(process.cwd(), filePath),
        line: position.line + 1,
        name: declarationName(declaration),
        missing: documentation ? missingSections.join("、") : "JSDoc"
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
