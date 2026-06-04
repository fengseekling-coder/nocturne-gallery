/**
 * Thumbnail URL cache (convertFileSrc) with O(1) LRU eviction.
 */

import { convertFileSrc } from '@tauri-apps/api/core';

const MAX_ASSET_URL_CACHE_ENTRIES = 1200;

type LruNode = {
  key: string;
  url: string;
  prev: LruNode | null;
  next: LruNode | null;
};

const cache = new Map<string, LruNode>();
let head: LruNode | null = null;
let tail: LruNode | null = null;

function removeNode(node: LruNode): void {
  if (node.prev) node.prev.next = node.next;
  else head = node.next;
  if (node.next) node.next.prev = node.prev;
  else tail = node.prev;
  node.prev = null;
  node.next = null;
}

function insertAtTail(node: LruNode): void {
  node.next = null;
  node.prev = tail;
  if (tail) tail.next = node;
  else head = node;
  tail = node;
}

function touchNode(node: LruNode): void {
  if (tail === node) return;
  removeNode(node);
  insertAtTail(node);
}

function evictOldest(count: number): void {
  for (let i = 0; i < count && head; i += 1) {
    const victim = head;
    removeNode(victim);
    cache.delete(victim.key);
  }
}

export function getAssetUrl(filePath: string): string {
  const existing = cache.get(filePath);
  if (existing) {
    touchNode(existing);
    return existing.url;
  }

  const url = convertFileSrc(filePath);
  const node: LruNode = { key: filePath, url, prev: null, next: null };
  cache.set(filePath, node);
  insertAtTail(node);

  if (cache.size > MAX_ASSET_URL_CACHE_ENTRIES) {
    evictOldest(Math.max(64, Math.ceil(MAX_ASSET_URL_CACHE_ENTRIES * 0.12)));
  }

  return url;
}

export function preloadThumbnails(paths: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const unique = [...new Set(paths.filter(Boolean))];
  for (const path of unique) {
    result.set(path, getAssetUrl(path));
  }
  return Promise.resolve(result);
}

export function getCachedUrl(filePath: string): string {
  return getAssetUrl(filePath);
}

export function clearAll(): void {
  cache.clear();
  head = null;
  tail = null;
}