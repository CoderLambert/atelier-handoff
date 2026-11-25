/**
 * @file 测试 Git 右键上下文菜单坐标计算与边界翻转逻辑。
 * @implementation 验证右边缘平移与底边缘向上翻转防止被截断。
 * @updated 2026-11-25T03:35:00+08:00
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { computeContextMenuCoords } from '../frontend/src/features/git/git-coords.js';

describe('Git 右键菜单边界计算', () => {
  const windowWidth = 1200;
  const windowHeight = 800;
  const menuWidth = 200;
  const menuHeight = 220;

  test('常规居中点击保持原位', () => {
    const { left, top } = computeContextMenuCoords(
      400,
      300,
      menuWidth,
      menuHeight,
      windowWidth,
      windowHeight,
    );
    assert.equal(left, 400);
    assert.equal(top, 300);
  });

  test('接近屏幕右边缘自动向左收窄防超出', () => {
    const { left, top } = computeContextMenuCoords(
      1150,
      300,
      menuWidth,
      menuHeight,
      windowWidth,
      windowHeight,
    );
    // 1200 - 200 - 8 = 992
    assert.equal(left, 992);
    assert.equal(top, 300);
  });

  test('接近屏幕底部边缘自动向上翻转防截断', () => {
    const { left, top } = computeContextMenuCoords(
      500,
      750,
      menuWidth,
      menuHeight,
      windowWidth,
      windowHeight,
    );
    assert.equal(left, 500);
    // 750 + 220 > 800 - 8 (792)，触发向上翻转: 750 - 220 = 530
    assert.equal(top, 530);
  });

  test('右下角边缘同时触发水平平移与垂直向上翻转', () => {
    const { left, top } = computeContextMenuCoords(
      1180,
      780,
      menuWidth,
      menuHeight,
      windowWidth,
      windowHeight,
    );
    assert.equal(left, 992);
    assert.equal(top, 560);
  });
});
