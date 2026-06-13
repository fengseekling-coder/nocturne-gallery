/**
 * Gega Gallery — UI 类型定义
 */

/** 侧边栏导航项 */
export interface NavItem {
  id: string;
  label: string;
  /** Gega SVG 图标名，例如 "grid_view" */
  icon: string;
  badge?: number;
}

/** Toast 通知状态 */
export interface ToastState {
  visible: boolean;
  message: string;
}
