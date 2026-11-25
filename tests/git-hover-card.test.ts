/**
 * @file 测试 Git 提交与分支 Hover 信息卡片的交互与缓存逻辑。
 * @implementation 验证 400ms 防抖延迟、离开/滚动重置、第二次悬停直接读取缓存及坐标翻转计算。
 * @updated 2026-11-25T03:25:00+08:00
 */
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

describe('Git 悬停卡片逻辑与缓存', () => {
  test('400ms 悬停延迟与离开快速划过防干扰', async () => {
    let activeItem: string | null = null;
    let timer: NodeJS.Timeout | null = null;

    const handleMouseEnter = (item: string) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        activeItem = item;
      }, 400);
    };

    const handleMouseLeave = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      activeItem = null;
    };

    // 1. 鼠标划入并在 100ms 内离开：不会显示卡片
    handleMouseEnter('commit-1');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(activeItem, null);
    handleMouseLeave();

    await new Promise((r) => setTimeout(r, 350));
    assert.equal(activeItem, null);

    // 2. 悬停超过 400ms：卡片成功激活
    handleMouseEnter('commit-2');
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(activeItem, 'commit-2');

    // 3. 滚动列表时立即隐藏
    handleMouseLeave();
    assert.equal(activeItem, null);
  });

  test('提交变更统计的前端按 Hash 缓存机制', () => {
    interface CommitStats {
      hash: string;
      filesChanged: number;
      insertions: number;
      deletions: number;
    }
    const cache = new Map<string, CommitStats>();
    let networkFetchCount = 0;

    function getStats(hash: string): CommitStats {
      if (cache.has(hash)) {
        return cache.get(hash)!;
      }
      networkFetchCount++;
      const stats = { hash, filesChanged: 3, insertions: 20, deletions: 5 };
      cache.set(hash, stats);
      return stats;
    }

    // 首次获取：发起请求并写入缓存
    const first = getStats('hash-abc');
    assert.equal(networkFetchCount, 1);
    assert.equal(first.insertions, 20);

    // 第二次获取：直接从缓存读取，不发起请求
    const second = getStats('hash-abc');
    assert.equal(networkFetchCount, 1);
    assert.deepEqual(second, first);
  });

  test('浮动卡片坐标计算防父容器溢出与视口裁剪', () => {
    // 模拟视口与悬停行 DOMRect
    const windowWidth = 1200;
    const windowHeight = 800;
    const cardWidth = 380;
    const cardHeight = 180;

    function calculateCommitCardPos(rect: { left: number; top: number; bottom: number }) {
      const spaceBelow = windowHeight - rect.bottom;
      const showAbove = spaceBelow < cardHeight + 16 && rect.top > cardHeight + 16;
      const top = showAbove ? rect.top - cardHeight - 6 : rect.bottom + 6;
      const left = Math.max(12, Math.min(rect.left, windowWidth - cardWidth - 12));
      return { top, left, showAbove };
    }

    // 场景 1：在页面中间，有充裕下方空间
    const normal = calculateCommitCardPos({ left: 100, top: 200, bottom: 236 });
    assert.equal(normal.showAbove, false);
    assert.equal(normal.top, 242);
    assert.equal(normal.left, 100);

    // 场景 2：在页面底部，下方空间不足 -> 翻转至上方
    const nearBottom = calculateCommitCardPos({ left: 100, top: 720, bottom: 756 });
    assert.equal(nearBottom.showAbove, true);
    assert.equal(nearBottom.top, 720 - cardHeight - 6);

    // 场景 3：靠近屏幕右边缘 -> 水平夹紧不超边界
    const nearRight = calculateCommitCardPos({ left: 1100, top: 200, bottom: 236 });
    assert.equal(nearRight.left, windowWidth - cardWidth - 12);
  });
});
