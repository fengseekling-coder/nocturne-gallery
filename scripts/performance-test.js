#!/usr/bin/env node

/**
 * Nocturne Gallery 性能测试脚本
 *
 * 使用方法:
 * npm run perf:test
 */

import { chromium } from '@playwright/test';
import { fileURLToPath } from 'url';

// 配置
const CONFIG = {
  headless: false, // 设置为 true 可在后台运行
  timeout: 300000, // 5分钟超时
  viewport: { width: 1920, height: 1080 },
};

async function runPerformanceTests() {
  console.log('🚀 启动 Nocturne Gallery 性能测试...\n');

  const browser = await chromium.launch({
    headless: CONFIG.headless,
  });

  const context = await browser.newContext({
    viewport: CONFIG.viewport,
  });

  const page = await context.newPage();

  try {
    // 1. 打开应用
    console.log('📱 打开应用...');
    await page.goto('http://localhost:1420', {
      waitUntil: 'networkidle',
      timeout: CONFIG.timeout,
    });
    console.log('✅ 应用加载完成\n');

    // 2. 等待初始数据加载
    console.log('⏳ 等待数据加载...');
    await page.waitForSelector('[data-card-id]', { timeout: CONFIG.timeout });
    const initialCardCount = await page.$$eval('[data-card-id]', els => els.length);
    console.log(`📊 初始卡片数量: ${initialCardCount}\n`);

    // 3. 滚动性能测试
    console.log('🔄 测试滚动性能...');
    await measureScrollPerformance(page);

    // 4. 框选性能测试
    console.log('🖱️  测试框选性能...');
    await measureSelectionPerformance(page);

    // 5. 点击选中测试
    console.log('👆 测试点击选中性能...');
    await measureClickPerformance(page);

    // 6. 分组切换测试
    console.log('📁 测试分组切换性能...');
    await measureGroupSwitchingPerformance(page);

    // 7. 内存使用报告
    console.log('💾 生成内存使用报告...');
    await generateMemoryReport(page);

    console.log('\n🎉 性能测试完成！');
  } catch (error) {
    console.error('❌ 测试失败:', error.message);
  } finally {
    await browser.close();
  }
}

async function measureScrollPerformance(page) {
  const startTime = Date.now();

  // 记录 FPS
  await page.evaluate(() => {
    window.performanceTest = {
      frames: 0,
      lastTime: performance.now(),
      fps: 0,
    };

    const canvas = document.querySelector('.canvas-content');
    if (!canvas) return;

    // 监听滚动事件
    canvas.addEventListener('scroll', () => {
      window.performanceTest.frames++;
      const now = performance.now();
      if (now - window.performanceTest.lastTime >= 1000) {
        window.performanceTest.fps = Math.round(
          (window.performanceTest.frames * 1000) / (now - window.performanceTest.lastTime)
        );
        window.performanceTest.frames = 0;
        window.performanceTest.lastTime = now;
      }
    });
  });

  // 执行快速滚动
  await page.evaluate(async () => {
    const canvas = document.querySelector('.canvas-content');
    if (!canvas) return;

    const scrollHeight = canvas.scrollHeight;
    const steps = 50;
    const stepSize = scrollHeight / steps;

    for (let i = 0; i <= steps; i++) {
      canvas.scrollTop = i * stepSize;
      await new Promise(resolve => setTimeout(resolve, 20)); // 20ms per step
    }
  });

  // 获取 FPS 数据
  const fps = await page.evaluate(() => window.performanceTest?.fps || 0);
  const duration = Date.now() - startTime;

  console.log(`   滚动 FPS: ${fps}`);
  console.log(`   测试耗时: ${duration}ms`);
  console.log(`   结果: ${fps >= 55 ? '✅ 优秀' : fps >= 50 ? '⚠️  可接受' : '❌ 需要优化'}\n`);

  return fps;
}

async function measureSelectionPerformance(page) {
  const startTime = Date.now();

  // 执行框选操作
  await page.mouse.move(100, 100);
  await page.mouse.down();
  await page.mouse.move(800, 600, { steps: 20 });
  await page.mouse.up();

  const duration = Date.now() - startTime;

  // 获取选中数量
  const selectedCount = await page.$$eval('[data-card-id].is-selected', els => els.length);

  console.log(`   选中卡片数: ${selectedCount}`);
  console.log(`   操作耗时: ${duration}ms`);
  console.log(`   结果: ${duration < 100 ? '✅ 优秀' : duration < 200 ? '⚠️  可接受' : '❌ 需要优化'}\n`);

  return duration;
}

async function measureClickPerformance(page) {
  const startTime = Date.now();

  // 连续点击多个卡片
  const cards = await page.$$('[data-card-id]');
  const clickCount = Math.min(10, cards.length);

  for (let i = 0; i < clickCount; i++) {
    await cards[i].click();
    await page.waitForTimeout(50); // 短暂延迟
  }

  const duration = Date.now() - startTime;
  const avgTime = duration / clickCount;

  console.log(`   点击次数: ${clickCount}`);
  console.log(`   平均响应时间: ${avgTime.toFixed(2)}ms`);
  console.log(`   总耗时: ${duration}ms`);
  console.log(`   结果: ${avgTime < 50 ? '✅ 优秀' : avgTime < 100 ? '⚠️  可接受' : '❌ 需要优化'}\n`);

  return avgTime;
}

async function measureGroupSwitchingPerformance(page) {
  const startTime = Date.now();

  // 获取所有导航按钮
  const navButtons = await page.$$('[data-drop-target-nav]');

  if (navButtons.length > 1) {
    // 快速切换几个分组
    for (let i = 0; i < Math.min(3, navButtons.length); i++) {
      await navButtons[i].click();
      await page.waitForSelector('[data-card-id]', { timeout: 5000 });
      await page.waitForTimeout(200); // 等待稳定
    }
  }

  const switchCount = Math.min(3, navButtons.length);
  const duration = Date.now() - startTime;
  const avgTime = switchCount > 0 ? duration / switchCount : 0;

  console.log(`   切换次数: ${Math.min(3, navButtons.length)}`);
  console.log(`   平均切换时间: ${avgTime.toFixed(2)}ms`);
  console.log(`   总耗时: ${duration}ms`);
  console.log(`   结果: ${avgTime < 500 ? '✅ 优秀' : avgTime < 1000 ? '⚠️  可接受' : '❌ 需要优化'}\n`);

  return avgTime;
}

async function generateMemoryReport(page) {
  const metrics = await page.metrics();

  console.log('   JS Heap 使用:', `${(metrics.JSHeapUsedSize / 1024 / 1024).toFixed(2)} MB`);
  console.log('   JS Heap 总量:', `${(metrics.JSHeapTotalSize / 1024 / 1024).toFixed(2)} MB`);
  console.log('   DOM 节点数:', metrics.Nodes || 'N/A');
  console.log('   布局计数:', metrics.LayoutCount || 'N/A');
  console.log('   样式重计算:', metrics.RecalcStyleCount || 'N/A');
  console.log('');
}

// 运行测试
const __filename = fileURLToPath(import.meta.url);
const isDirectExecution = process.argv[1] === __filename;

if (isDirectExecution) {
  runPerformanceTests().catch(console.error);
}

export { runPerformanceTests };
