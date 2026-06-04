/**
 * Nocturne Gallery — LibrarySetup 欢迎页面
 *
 * 首次启动时显示，引导用户选择或创建灵感库根目录
 */

import React, { useState, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { GegaLogo } from '../common/GegaLogo';
import { Icon } from '../common/Icon';
import { useUiStore } from '../../stores/uiStore';

interface LibrarySetupProps {
  onSetup: (rootPath: string) => void;
  initialRoot?: string | null;
}

export const LibrarySetup: React.FC<LibrarySetupProps> = ({ onSetup, initialRoot = null }) => {
  const showConfirm = useUiStore((s) => s.showConfirm);
  const [selectedPath, setSelectedPath] = useState<string>('');
  const [isCreating, setIsCreating] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string>('');

  // 启动时读取已保存的库根目录；如果 App 已经拿到 root，则不要重复查询
  useEffect(() => {
    if (initialRoot && initialRoot.trim() !== '') {
      setSelectedPath(initialRoot);
    }
  }, [initialRoot]);

  // 选择现有目录（用户选择的目录会直接作为灵感库根目录）
  const handleSelectFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: '选择灵感库根目录',
      });
      if (selected && typeof selected === 'string') {
        setSelectedPath(selected);
      }
    } catch (err) {
      console.error('[LibrarySetup] handleSelectFolder error:', err);
    }
  };

  // 使用文档目录作为默认父目录
  const handleCreateDefault = async () => {
    setIsCreating(true);
    try {
      // 使用 Tauri 获取用户文档目录
      const { appDataDir } = await import('@tauri-apps/api/path');
      const appData = await appDataDir();
      // 默认使用系统文档目录：AppData 的上级目录的 Documents
      const homeDir = appData.replace(/[\\/][^\\/]*$/, '').replace(/[\\/][^\\/]*$/, '') + '/Documents';
      setSelectedPath(homeDir);
    } catch (err) {
      console.error('[LibrarySetup] handleCreateDefault error:', err);
      setSelectedPath('C:/Users/Public/Documents');
    } finally {
      setIsCreating(false);
    }
  };

  // 确认设置（将所选目录作为灵感库根目录）
  const handleConfirm = async () => {
    console.log('[LibrarySetup] handleConfirm called, selectedPath:', selectedPath);
    if (!selectedPath) {
      console.warn('[LibrarySetup] No path selected');
      await showConfirm({
        title: '提示',
        message: '请先选择一个目录',
        confirmText: '确定',
        cancelText: '',
      });
      return;
    }

    setIsInitializing(true);
    setErrorMsg('');

    try {
      console.log('[LibrarySetup] Calling onSetup with:', selectedPath);
      await onSetup(selectedPath);
      console.log('[LibrarySetup] onSetup completed successfully');
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[LibrarySetup] handleConfirm error:', err);
      setErrorMsg(errorMsg);
    } finally {
      setIsInitializing(false);
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        backgroundColor: 'var(--bg-primary)',
        fontFamily: 'var(--font-family)',
        padding: '40px',
      }}
    >
      {/* Logo 区域 */}
      <div
        style={{
          textAlign: 'center',
          marginBottom: '40px',
        }}
      >
        <GegaLogo width={48} height={48} style={{ display: 'block', margin: '0 auto 12px auto' }} />
        <p
          style={{
            fontFamily: 'var(--font-family)',
            fontSize: '13px',
            color: 'var(--text-muted)',
            margin: 0,
            fontWeight: 400,
          }}
        >
          灵感库 — 您的私人素材管理中心
        </p>
      </div>

      {/* 主内容卡片 */}
      <div
        style={{
          backgroundColor: 'var(--bg-surface)',
          borderRadius: 'var(--radius-card)',
          padding: '32px',
          maxWidth: '520px',
          width: '100%',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <h2
          style={{
            fontFamily: 'var(--font-family)',
            fontSize: '20px',
            fontWeight: 600,
            color: 'var(--text-primary)',
            margin: '0 0 16px 0',
          }}
        >
          欢迎使用 Gega Gallery
        </h2>

        <p
          style={{
            fontFamily: 'var(--font-family)',
            fontSize: '13px',
            color: 'var(--text-secondary)',
            margin: '0 0 24px 0',
            lineHeight: 1.6,
          }}
        >
          首先请选择一个位置，Gega 将<b>直接使用您选择的目录作为灵感库根目录</b>。
          软件将在此目录下创建固定结构来管理您的素材、项目和渲染队列。
        </p>

        {/* 目录结构预览 */}
        <div
          style={{
            backgroundColor: 'var(--bg-hover)',
            borderRadius: 'var(--radius-small)',
            padding: '16px',
            marginBottom: '24px',
            fontFamily: 'var(--font-family)',
            fontSize: '12px',
            color: 'var(--text-secondary)',
          }}
        >
          <div style={{ color: 'var(--accent)', marginBottom: '8px' }}>📁 您选择的 position/</div>
          <div style={{ paddingLeft: '16px' }}>
            <div style={{ color: 'var(--accent)' }}>📁 你选择的目录 ← 直接使用</div>
            <div style={{ paddingLeft: '16px' }}>
              <div>.nocturne/ ← 软件数据目录</div>
              <div>灵感库/ ← 素材放这里</div>
              <div>作品集/</div>
              <div>渲染队列/</div>
              <div>回收站/</div>
            </div>
          </div>
        </div>

        {/* 路径选择 */}
        <div style={{ marginBottom: '24px' }}>
          <label
            style={{
              display: 'block',
              fontFamily: 'var(--font-family)',
              fontSize: '13px',
              fontWeight: 500,
              color: 'var(--text-primary)',
              marginBottom: '8px',
            }}
          >
            库根目录路径
          </label>

          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              type="text"
              value={selectedPath}
              onChange={(e) => setSelectedPath(e.target.value)}
              placeholder="选择或输入目录路径..."
              style={{
                flex: 1,
                padding: '12px 16px',
                backgroundColor: 'var(--bg-primary)',
                border: 'none',
                boxShadow: 'inset 0 0 0 1px var(--border)',
                borderRadius: 'var(--radius-default)',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-family)',
                fontSize: '13px',
                outline: 'none',
              }}
            />
            <button
              onClick={handleSelectFolder}
              style={{
                padding: '12px 16px',
                backgroundColor: 'var(--bg-hover)',
                border: 'none',
                borderRadius: 'var(--radius-default)',
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-family)',
                fontSize: '13px',
                cursor: 'pointer',
                transition: 'all var(--transition-default)',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)';
                (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-on-accent)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--bg-hover)';
                (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)';
              }}
            >
              浏览
            </button>
          </div>
        </div>

        {/* 快速创建按钮 */}
        <button
          onClick={handleCreateDefault}
          disabled={isCreating}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            width: '100%',
            padding: '12px 16px',
            backgroundColor: 'var(--bg-hover)',
            border: 'none',
            borderRadius: 'var(--radius-default)',
            color: 'var(--text-secondary)',
            fontFamily: 'var(--font-family)',
            fontSize: '13px',
            cursor: isCreating ? 'not-allowed' : 'pointer',
            opacity: isCreating ? 0.6 : 1,
            transition: 'all var(--transition-default)',
            marginBottom: '24px',
          }}
        >
          <Icon name="create_new_folder" size={16} />
          {isCreating ? '创建中...' : '快速创建默认目录'}
        </button>

        {/* 确认按钮 */}
        <button
          onClick={handleConfirm}
          disabled={!selectedPath || isInitializing}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            padding: '16px 24px',
            background: 'linear-gradient(135deg, var(--accent), var(--accent))',
            border: 'none',
            borderRadius: 'var(--radius-pill)',
            color: 'var(--bg-primary)',
            fontFamily: 'var(--font-family)',
            fontSize: '13px',
            fontWeight: 600,
            cursor: (selectedPath && !isInitializing) ? 'pointer' : 'not-allowed',
            opacity: (selectedPath && !isInitializing) ? 1 : 0.5,
            transition: 'all var(--transition-default)',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          <Icon
            name={isInitializing ? 'progress_activity' : 'check_circle'}
            size={16}
            fill={isInitializing ? 0 : 1}
            style={{ marginRight: '8px', animation: isInitializing ? 'spin 1s linear infinite' : undefined }}
          />
          {isInitializing ? '初始化中...' : '开始使用'}
        </button>

        {/* 错误显示区 */}
        {errorMsg && (
          <p style={{ color: 'var(--error)', fontSize: '13px', marginTop: '12px', marginBottom: 0, textAlign: 'center' }}>
            {errorMsg}
          </p>
        )}
      </div>

      {/* 底部提示 */}
      <p
        style={{
          fontFamily: 'var(--font-family)',
          fontSize: '12px',
          color: 'var(--text-muted)',
          marginTop: '20px',
          margin: 0,
        }}
      >
        💡 提示：您可以随时在设置中更改库根目录位置
      </p>
    </div>
  );
};
