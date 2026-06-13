/**
 * Gega Gallery — 网页书签类型定义
 */

export interface Bookmark {
  id: number;
  url: string;
  title: string | null;
  description: string | null;
  faviconUrl: string | null;
  tags: string | null;
  createdAt: string;
}
