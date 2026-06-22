import { randomUUID } from "node:crypto";

/**
 * 使用方法：创建 Session、Message、Plan、Result 或 Audit 对象时传入短前缀。
 * 作用：使用 UUID 随机片段生成便于阅读和分类的本地唯一标识。
 * 边界：ID 适合本地关联，不承诺全局排序，也不包含业务语义。
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

/**
 * 使用方法：创建或更新持久化对象时调用。
 * 作用：统一返回当前时间的 ISO 8601 字符串。
 * 边界：使用系统时钟和 UTC 表示，不负责时钟同步或本地化展示。
 */
export function nowIso(): string {
  return new Date().toISOString();
}
