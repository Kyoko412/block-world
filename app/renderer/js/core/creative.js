'use strict';
/*
 * E1：创造物品栏搜索的纯逻辑（无 DOM）。
 * 搜索范围是所有分类的并集；按中文名包含匹配，按物品 id 忽略大小写包含匹配。
 * 同一物品在多个分类重复出现时只保留第一次出现，顺序稳定。
 */
import { CREATIVE_TABS, ITEMS, itemName } from './items.js';

/** 全部分类的并集（去重、保持分类顺序） */
export function creativePool(tabs = CREATIVE_TABS) {
  const out = [];
  const seen = new Set();
  for (const tab of (tabs || [])) {
    for (const id of (tab.items || [])) {
      if (!ITEMS[id] || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * @param {string} query 搜索词（去首尾空白；空串表示不过滤）
 * @param {Array} tabs 可选分类表，便于单测
 * @returns {{query:string, items:string[], count:number, empty:boolean, mode:'all'|'filtered'}}
 */
export function filterCreativeItems(query, tabs = CREATIVE_TABS) {
  const q = String(query === undefined || query === null ? '' : query).trim();
  const pool = creativePool(tabs);
  if (!q) return { query: '', items: pool, count: pool.length, empty: pool.length === 0, mode: 'all' };
  const lower = q.toLowerCase();
  const items = pool.filter(id => {
    const zh = itemName(id) || '';
    return zh.includes(q) || id.toLowerCase().includes(lower);
  });
  return { query: q, items, count: items.length, empty: items.length === 0, mode: 'filtered' };
}
