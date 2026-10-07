/**
 * 状态根目录（独立模块：connectors.js ⇄ local-connectors.js 曾经互引造成
 * ESM 循环依赖、STATE_ROOT 撞 TDZ —— 提出来后两端单向引用）。
 */
import { join } from "node:path";
import { homedir } from "node:os";

export const STATE_ROOT = join(homedir(), ".dsh/workbuddy-summon");
