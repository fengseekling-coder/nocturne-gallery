/**
 * 滚动性能自动化测试脚本
 *
 * 测试流程：
 * 1. 连接到已运行的 Tauri 应用 (localhost:1420-1423)
 * 2. 进入灵感库网格
 * 3. Ctrl+R 刷新
 * 4. 连续快速滚动 30 秒
 * 5. 捕获控制台日志、截图和性能指标
 */

import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 配置
const CONFIG = {
  ports: [1420, 1421, 1422, 1423], // Tauri 可能使用的端口
  scrollDuration: 30000, // 滚动持续时间 30 秒
  screenshotDir: path.join(__dirname, '..', 'test-results', 'scroll-test'),
  logFile: path.join(__dirname, '..', 'test-results', 'scroll-test', 'console-log.json'),
};

// 确保输出目录存在
fs.mkdirSync(CONFIG.screenshotDir, { recursive: true });

async function findTauriApp() {
  console.log('🔍 查找 Tauri 应用...');
  for (const port of CONFIG.ports) {
    try {
      const url = `http://localhost:${port}`;
      const response = await fetch(url, { timeout: 2000 });
      if (response.ok) {
        console.log(`✅ 找到应用: ${url}`);
        return url;
      }
    } catch (e) {
      // 端口未响应，继续尝试下一个
    }
  }
  throw new Error('未找到运行中的 Tauri 应用，请确保已执行 npm run tauri:dev');
}

async function runScrollTest() {
  console.log('\n🚀 开始滚动性能测试\n');

  // 1. 查找应用
  const appUrl = await findTauriApp();

  // 2. 启动浏览器
  console.log('🌐 启动 Chromium 浏览器...');
  const browser = await chromium.launch({
    headless: false, // 非无头模式，方便观察
    slowMo: 0,
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
  });

  const page = await context.newPage();

  // 收集控制台日志
  const consoleLogs = [];
  const imageErrors = [];
  let mediaCardRenderCount = 0;

  page.on('console', (msg) => {
    const text = msg.text();
    consoleLogs.push({
      type: msg.type(),
      text: text,
      timestamp: Date.now(),
    });

    // 检测 MediaCard 相关日志
    if (text.includes('imageError') || text.includes('MediaCard')) {
      console.log(`[Console] ${text}`);
    }

    // 统计图片错误
    if (text.includes('Failed to load resource') || text.includes('imageError')) {
      imageErrors.push(text);
    }
  });

  page.on('pageerror', (error) => {
    consoleLogs.push({
      type: 'pageerror',
      text: error.message,
      timestamp: Date.now(),
    });
    console.log(`❌ Page Error: ${error.message}`);
  });

  // 3. 导航到应用
  console.log(`📄 加载页面: ${appUrl}`);
  await page.goto(appUrl, { waitUntil: 'networkidle', timeout: 30000 });
  console.log('✅ 页面加载完成');

  // 等待应用初始化
  await page.waitForTimeout(3000);

  // 4. 进入灵感库
  console.log('📂 点击进入灵感库...');

  // 尝试点击左侧导航的"灵感库"按钮
  // 根据项目结构，灵感库应该是第一个主导航项
  const inspirationLibrarySelectors = [
    'button:has-text("灵感库")',
    '[data-testid="inspiration-library"]',
    '.sidebar-nav button:first-child',
    'text=灵感库',
  ];

  let clicked = false;
  for (const selector of inspirationLibrarySelectors) {
    try {
      const element = page.locator(selector).first();
      if (await element.count() > 0) {
        await element.click();
        console.log(`✅ 使用选择器 "${selector}" 点击成功`);
        clicked = true;
        break;
      }
    } catch (e) {
      // 尝试下一个选择器
    }
  }

  if (!clicked) {
    console.warn('⚠️  未找到灵感库按钮，假设已在默认视图');
  }

  // 等待内容加载 - 等待至少一个 .media-card 出现
  console.log('⏳ 等待卡片渲染...');
  try {
    await page.waitForSelector('.media-card', { timeout: 10000 });
    console.log('✅ 检测到卡片元素');
  } catch (e) {
    console.warn('⚠️  未检测到 .media-card，尝试其他选择器...');
    
    // 调试：输出页面结构
    const debugInfo = await page.evaluate(() => {
      return {
        bodyChildren: document.body.children.length,
        rootDiv: document.querySelector('#root') ? 'exists' : 'missing',
        rootChildren: document.querySelector('#root')?.children.length || 0,
        allDivs: document.querySelectorAll('div').length,
        firstFewClasses: Array.from(document.querySelectorAll('div')).slice(0, 20).map(d => d.className).filter(Boolean),
      };
    });
    console.log('🔍 页面结构:', JSON.stringify(debugInfo, null, 2));
  }
  
  await page.waitForTimeout(3000);

  // 5. Ctrl+R 刷新
  console.log('🔄 执行 Ctrl+R 刷新...');
  await page.keyboard.press('Control+R');
  
  // 等待刷新后重新加载
  await page.waitForTimeout(5000);
  
  // 再次等待卡片
  try {
    await page.waitForSelector('.media-card', { timeout: 10000 });
    console.log('✅ 刷新后卡片已渲染');
  } catch (e) {
    console.warn('⚠️  刷新后仍未检测到卡片');
  }

  // 6. 截图 - 刷新后初始状态
  const initialScreenshot = path.join(CONFIG.screenshotDir, '01-initial.png');
  await page.screenshot({ path: initialScreenshot, fullPage: false });
  console.log(`📸 初始状态截图: ${initialScreenshot}`);

  // 7. 检测初始空黑卡数量
  console.log('\n📊 检测初始卡片状态...');
  const initialMetrics = await page.evaluate(() => {
    const cards = document.querySelectorAll('.media-card');
    const metrics = {
      totalCards: cards.length,
      emptyCards: 0,
      loadedCards: 0,
      blackCards: 0,
    };

    cards.forEach((card, index) => {
      const img = card.querySelector('img');
      const canvas = card.querySelector('canvas');

      if (!img && !canvas) {
        metrics.emptyCards++;
      } else if (img) {
        // 检查图片是否加载
        if (img.complete && img.naturalWidth > 0) {
          metrics.loadedCards++;
        } else if (img.src === '' || img.src.includes('asset.localhost')) {
          metrics.blackCards++;
        }
      }
    });

    return metrics;
  });

  console.log(`   总卡片数: ${initialMetrics.totalCards}`);
  console.log(`   已加载: ${initialMetrics.loadedCards}`);
  console.log(`   空卡片: ${initialMetrics.emptyCards}`);
  console.log(`   黑卡片: ${initialMetrics.blackCards}`);

  // 8. 开始滚动测试
  console.log(`\n🎢 开始 ${CONFIG.scrollDuration / 1000} 秒滚动测试...`);

  const scrollStartTime = Date.now();
  let scrollIterations = 0;

  // 注入性能监控脚本
  await page.evaluate(() => {
    window.__scrollPerformance = {
      frameDrops: 0,
      lastFrameTime: performance.now(),
      lowFPSCount: 0,
    };

    // 监控 FPS
    let lastTime = performance.now();
    let frames = 0;
    let fpsValues = [];

    function measureFPS() {
      const now = performance.now();
      frames++;

      if (now - lastTime >= 1000) {
        const fps = frames;
        fpsValues.push(fps);
        if (fps < 30) {
          window.__scrollPerformance.lowFPSCount++;
        }
        frames = 0;
        lastTime = now;
      }

      requestAnimationFrame(measureFPS);
    }

    requestAnimationFrame(measureFPS);
  });

  // 执行滚动
  const scrollInterval = setInterval(async () => {
    const elapsed = Date.now() - scrollStartTime;
    const progress = (elapsed / CONFIG.scrollDuration * 100).toFixed(0);

    // 随机滚动方向和距离
    const scrollAmount = Math.random() > 0.5 ? 800 : -800;
    await page.evaluate((amount) => {
      const container = document.querySelector('.canvas-content') ||
                       document.querySelector('[data-card-id]')?.closest('[class*="canvas"]') ||
                       document.documentElement;
      container.scrollBy({ top: amount, behavior: 'auto' });
    }, scrollAmount);

    scrollIterations++;

    // 每 5 秒截图一次
    if (scrollIterations % 5 === 0) {
      const screenshotPath = path.join(CONFIG.screenshotDir, `02-scroll-${scrollIterations}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
    }

    // 每 10 秒报告进度
    if (scrollIterations % 10 === 0) {
      console.log(`   进度: ${progress}% (${scrollIterations} 次滚动)`);
    }

    // 结束条件
    if (elapsed >= CONFIG.scrollDuration) {
      clearInterval(scrollInterval);
      console.log(`\n✅ 滚动测试完成 (共 ${scrollIterations} 次滚动)\n`);
    }
  }, 100); // 每 100ms 滚动一次

  // 等待滚动完成
  await new Promise(resolve => setTimeout(resolve, CONFIG.scrollDuration + 1000));

  // 9. 最终截图
  const finalScreenshot = path.join(CONFIG.screenshotDir, '03-final.png');
  await page.screenshot({ path: finalScreenshot, fullPage: false });
  console.log(`📸 最终状态截图: ${finalScreenshot}\n`);

  // 10. 收集最终指标
  console.log('📊 收集最终性能指标...');
  const finalMetrics = await page.evaluate(() => {
    const cards = document.querySelectorAll('.media-card');
    const metrics = {
      totalCards: cards.length,
      emptyCards: 0,
      loadedCards: 0,
      blackCards: 0,
      visibleCards: 0,
      visibleLoaded: 0,
    };

    cards.forEach((card) => {
      const rect = card.getBoundingClientRect();
      const isVisible = rect.top < window.innerHeight && rect.bottom > 0;

      if (isVisible) {
        metrics.visibleCards++;
      }

      const img = card.querySelector('img');
      const canvas = card.querySelector('canvas');

      if (!img && !canvas) {
        metrics.emptyCards++;
      } else if (img) {
        if (img.complete && img.naturalWidth > 0) {
          metrics.loadedCards++;
          if (isVisible) {
            metrics.visibleLoaded++;
          }
        } else {
          metrics.blackCards++;
        }
      }
    });

    return metrics;
  });

  // 获取 FPS 数据
  const fpsData = await page.evaluate(() => {
    return window.__scrollPerformance || {};
  });

  // 11. 汇总结果
  console.log('\n' + '='.repeat(80));
  console.log('📈 滚动性能测试结果汇总');
  console.log('='.repeat(80));

  console.log('\n【初始状态】');
  console.log(`  总卡片数: ${initialMetrics.totalCards}`);
  console.log(`  已加载: ${initialMetrics.loadedCards} (${(initialMetrics.loadedCards / initialMetrics.totalCards * 100).toFixed(1)}%)`);
  console.log(`  空卡片: ${initialMetrics.emptyCards}`);
  console.log(`  黑卡片: ${initialMetrics.blackCards}`);

  console.log('\n【最终状态】');
  console.log(`  总卡片数: ${finalMetrics.totalCards}`);
  console.log(`  已加载: ${finalMetrics.loadedCards} (${(finalMetrics.loadedCards / finalMetrics.totalCards * 100).toFixed(1)}%)`);
  console.log(`  空卡片: ${finalMetrics.emptyCards}`);
  console.log(`  黑卡片: ${finalMetrics.blackCards}`);
  console.log(`  视口内卡片: ${finalMetrics.visibleCards}`);
  console.log(`  视口内已加载: ${finalMetrics.visibleLoaded} (${(finalMetrics.visibleLoaded / finalMetrics.visibleCards * 100).toFixed(1)}%)`);

  console.log('\n【性能指标】');
  console.log(`  滚动次数: ${scrollIterations}`);
  console.log(`  低 FPS 秒数 (<30fps): ${fpsData.lowFPSCount || 0}s`);
  console.log(`  控制台日志条数: ${consoleLogs.length}`);
  console.log(`  图片错误数: ${imageErrors.length}`);

  console.log('\n【问题检测】');

  // 判断是否存在大面积空黑卡
  const hasLargeBlackAreas = finalMetrics.blackCards > finalMetrics.totalCards * 0.3;
  console.log(`  ${hasLargeBlackAreas ? '❌' : '✅'} 大面积空黑卡: ${hasLargeBlackAreas ? '存在' : '不存在'} (${finalMetrics.blackCards}/${finalMetrics.totalCards})`);

  // 判断缩略图加载速度
  const thumbnailLoadRate = finalMetrics.visibleLoaded / finalMetrics.visibleCards;
  const slowThumbnailLoad = thumbnailLoadRate < 0.8;
  console.log(`  ${slowThumbnailLoad ? '❌' : '✅'} 缩略图加载速度: ${slowThumbnailLoad ? '慢' : '正常'} (视口内加载率 ${(thumbnailLoadRate * 100).toFixed(1)}%)`);

  // 判断是否掉帧
  const hasFrameDrops = (fpsData.lowFPSCount || 0) > CONFIG.scrollDuration / 1000 * 0.3;
  console.log(`  ${hasFrameDrops ? '❌' : '✅'} 明显掉帧: ${hasFrameDrops ? '是' : '否'} (低 FPS 时间占比 ${((fpsData.lowFPSCount || 0) / (CONFIG.scrollDuration / 1000) * 100).toFixed(1)}%)`);

  // 判断 imageErrors 是否暴涨
  const hasImageErrorSpike = imageErrors.length > 50;
  console.log(`  ${hasImageErrorSpike ? '❌' : '✅'} MediaCard imageErrors 暴涨: ${hasImageErrorSpike ? '是' : '否'} (共 ${imageErrors.length} 个错误)`);

  console.log('\n【综合评估】');
  const issues = [hasLargeBlackAreas, slowThumbnailLoad, hasFrameDrops, hasImageErrorSpike].filter(Boolean).length;
  if (issues === 0) {
    console.log('  ✅ 优秀 - 无明显性能问题');
  } else if (issues <= 2) {
    console.log('  ⚠️  良好 - 存在少量性能问题，建议优化');
  } else {
    console.log('  ❌ 较差 - 存在严重性能问题，需要优先修复');
  }

  console.log('\n' + '='.repeat(80));

  // 12. 保存详细日志
  const reportData = {
    timestamp: new Date().toISOString(),
    testDuration: CONFIG.scrollDuration,
    scrollIterations,
    initialMetrics,
    finalMetrics,
    fpsData,
    consoleLogCount: consoleLogs.length,
    imageErrorCount: imageErrors.length,
    imageErrors: imageErrors.slice(0, 100), // 只保存前 100 个
    assessment: {
      hasLargeBlackAreas,
      slowThumbnailLoad,
      hasFrameDrops,
      hasImageErrorSpike,
      issueCount: issues,
    },
  };

  fs.writeFileSync(CONFIG.logFile, JSON.stringify(reportData, null, 2), 'utf-8');
  console.log(`\n💾 详细报告已保存: ${CONFIG.logFile}`);

  // 13. 清理
  console.log('\n🔚 测试完成，关闭浏览器...');
  await browser.close();

  return reportData;
}

// 执行测试
runScrollTest()
  .then((report) => {
    console.log('\n✅ 所有测试完成');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ 测试失败:', error.message);
    console.error(error.stack);
    process.exit(1);
  });
