/**
 * @file 计算 Git 右键上下文菜单与浮层坐标及防截断翻转。
 * @implementation 边界检查：屏幕右边缘向左收窄，屏幕底部边缘自动向上翻转。
 * @updated 2026-11-25T03:47:00+08:00
 */
export function computeContextMenuCoords(
  clickX: number,
  clickY: number,
  menuWidth: number,
  menuHeight: number,
  windowWidth: number,
  windowHeight: number,
  padding = 8,
) {
  let left = clickX;
  let top = clickY;

  // 水平边界检查：若超出右侧边缘，向左翻转或平移
  if (left + menuWidth > windowWidth - padding) {
    left = Math.max(padding, windowWidth - menuWidth - padding);
  }

  // 垂直边界检查：若超出底部边缘，自动向上翻转
  if (top + menuHeight > windowHeight - padding) {
    top = Math.max(padding, clickY - menuHeight);
  }

  return { left, top };
}
