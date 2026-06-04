/**
 * Gega Gallery — 首选项弹窗
 *
 * 居中 Modal 弹窗，点击左侧「设置」按钮打开。
 * 包含：灵感库位置 / AI 模型配置 / 关于
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Icon } from '../common/Icon';
import { useUiStore } from '../../stores/uiStore';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

interface ModelConfig {
  id: string;
  provider: 'claude' | 'bailian' | 'openai' | 'tavily';
  displayName: string;
  model: string;
  apiKey?: string;
  url?: string;
}

interface AddFormState {
  provider: ModelConfig['provider'];
  model: string;
  apiKey: string;
  url: string;
  showKey: boolean;
}

interface OpenAiConfigView {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeySource: string;
}

interface OpenAiModelsResult {
  baseUrl: string;
  models: string[];
  imageModels: string[];
}

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

const PROVIDER_META: Record<
  string,
  { letter: string; label: string; needsKey: boolean; needsUrl: boolean }
> = {
  claude:  { letter: 'C',  label: 'Claude',   needsKey: true,  needsUrl: false },
  openai:  { letter: 'AI', label: 'OpenAI-compatible', needsKey: true, needsUrl: true },
  bailian: { letter: '炼', label: '百炼',     needsKey: true,  needsUrl: false },
  tavily:  { letter: '搜', label: '联网搜索', needsKey: true,  needsUrl: false },
};

const DEFAULT_FORM: AddFormState = {
  provider: 'openai',
  model: 'gpt-5.5-high',
  apiKey: '',
  url: 'http://127.0.0.1:8317/v1',
  showKey: false,
};

const OPENAI_CHAT_MODELS = ['gpt-5.5-fast', 'gpt-5.5-standard', 'gpt-5.5-high', 'gpt-5.5-max'];
const isOpenAiChatModel = (model: string): boolean => OPENAI_CHAT_MODELS.includes(model);

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function getProviderLetter(config: ModelConfig): string {
  return PROVIDER_META[config.provider]?.letter ?? '?';
}

async function migrateFromOldKeys(): Promise<ModelConfig[]> {
  const get = (key: string) =>
    invoke<string | null>('get_preference', { key }).catch(() => null);
  const [claude, bailianKey, bailianMod, tavily] = await Promise.all([
    get('claude_api_key'),
    get('bailian_api_key'), get('bailian_model'), get('tavily_api_key'),
  ]);
  const list: ModelConfig[] = [];
  if (claude) {
    list.push({
      id: crypto.randomUUID(),
      provider: 'claude',
      displayName: 'Claude',
      model: 'claude-sonnet-4-6',
      apiKey: claude,
    });
  }
  if (bailianKey) {
    list.push({
      id: crypto.randomUUID(),
      provider: 'bailian',
      displayName: '百炼',
      model: bailianMod || 'qwen-plus',
      apiKey: bailianKey,
    });
  }
  if (tavily) {
    list.push({
      id: crypto.randomUUID(),
      provider: 'tavily',
      displayName: '联网搜索',
      model: 'Tavily',
      apiKey: tavily,
    });
  }
  return list;
}

// ──────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────

export const PreferencesPanel: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const showConfirm = useUiStore((s) => s.showConfirm);
  const [libraryRoot, setLibraryRoot] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRescanning, setIsRescanning] = useState(false);
  const [isRehydrating, setIsRehydrating] = useState(false);
  const [rehydrateStatus, setRehydrateStatus] = useState<string | null>(null);
  const rehydrateSummary = useMemo(() => rehydrateStatus || '未执行', [rehydrateStatus]);
  const rehydrateDescription = '补齐旧库中缺失的缩略图、预览图、颜色、Hash 和尺寸字段，执行后会自动刷新列表。';
  const [isClosing, setIsClosing] = useState(false);

  // AI model list
  const [modelList, setModelList] = useState<ModelConfig[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState<AddFormState>(DEFAULT_FORM);
  const [openAiModels, setOpenAiModels] = useState<string[]>([]);
  const [isTestingOpenAi, setIsTestingOpenAi] = useState(false);
  const [openAiTestStatus, setOpenAiTestStatus] = useState<'idle' | 'success' | 'error'>('idle');

  const appVersion = '0.1.0';

  const savePref = useCallback(async (key: string, value: string) => {
    try { await invoke('set_preference', { key, value }); } catch { /* ignore */ }
  }, []);

  // Persist model list + keep individual keys for backward compat with DetailPanel
  const persistModelList = useCallback((list: ModelConfig[]) => {
    savePref('model_configs', JSON.stringify(list));
    const claude  = list.find(m => m.provider === 'claude');
    const bailian = list.find(m => m.provider === 'bailian');
    const openai  = list.find(m => m.provider === 'openai');
    const tavily  = list.find(m => m.provider === 'tavily');
    if (claude)  { savePref('claude_api_key', claude.apiKey || ''); }
    if (bailian) { savePref('bailian_api_key', bailian.apiKey || ''); savePref('bailian_model', bailian.model); }
    if (openai)  { savePref('openai_base_url', openai.url || 'http://127.0.0.1:8317/v1'); savePref('openai_model', openai.model || 'gpt-5.5-high'); if (openai.apiKey) savePref('openai_api_key', openai.apiKey); }
    if (tavily)  { savePref('tavily_api_key', tavily.apiKey || ''); }
  }, [savePref]);

  const handleCloseWithAnimation = useCallback(() => {
    setIsClosing(true);
    setTimeout(() => onClose(), 150);
  }, [onClose]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') handleCloseWithAnimation(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleCloseWithAnimation]);

  // Load config
  useEffect(() => {
    const load = async () => {
      try {
        const root = await invoke<string | null>('get_library_root');
        setLibraryRoot(root);

        // 1. Load stored list or migrate from old keys
        let loadedList: ModelConfig[] = [];
        const stored = await invoke<string | null>('get_preference', { key: 'model_configs' });
        if (stored) {
          try { loadedList = JSON.parse(stored) as ModelConfig[]; } catch { /* fall through */ }
        }
        if (!stored || loadedList.length === 0) {
          loadedList = await migrateFromOldKeys();
          if (loadedList.length > 0) {
            savePref('model_configs', JSON.stringify(loadedList));
          }
        }

        loadedList = loadedList
          .filter(config => Object.prototype.hasOwnProperty.call(PROVIDER_META, config.provider))
          .map(config => (
            config.provider === 'openai' && !isOpenAiChatModel(config.model)
              ? { ...config, model: 'gpt-5.5-high' }
              : config
          ));
        if (stored) {
          savePref('model_configs', JSON.stringify(loadedList));
        }

        try {
          const openAiConfig = await invoke<OpenAiConfigView>('openai_get_config');
          if (openAiConfig.hasApiKey && !loadedList.some(m => m.provider === 'openai')) {
            loadedList = [...loadedList, {
              id: crypto.randomUUID(),
              provider: 'openai',
              displayName: 'OpenAI-compatible',
              model: openAiConfig.model || 'gpt-5.5-high',
              url: openAiConfig.baseUrl || 'http://127.0.0.1:8317/v1',
            }];
            savePref('model_configs', JSON.stringify(loadedList));
            savePref('openai_base_url', openAiConfig.baseUrl || 'http://127.0.0.1:8317/v1');
            savePref('openai_model', openAiConfig.model || 'gpt-5.5-high');
          }
        } catch {
          /* OpenAI-compatible API is optional */
        }

        setModelList(loadedList);
      } catch (err) {
        console.error('[Preferences] load error:', err);
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [savePref]);

  const handleTestOpenAiInForm = async () => {
    setIsTestingOpenAi(true);
    setOpenAiTestStatus('idle');
    setOpenAiModels([]);
    try {
      if (addForm.url.trim()) await savePref('openai_base_url', addForm.url.trim());
      if (addForm.apiKey.trim()) await savePref('openai_api_key', addForm.apiKey.trim());
      if (addForm.model.trim()) await savePref('openai_model', addForm.model.trim());

      const result = await invoke<OpenAiModelsResult>('openai_list_models');
      const chatModels = result.models.length > 0 ? result.models : OPENAI_CHAT_MODELS;
      setOpenAiModels(chatModels);
      setOpenAiTestStatus('success');
      if (chatModels.length > 0 && !addForm.model) {
        const preferred = chatModels.includes('gpt-5.5-high') ? 'gpt-5.5-high' : chatModels[0];
        setAddForm(f => ({ ...f, model: preferred, url: result.baseUrl || f.url }));
      }
    } catch {
      setOpenAiTestStatus('error');
    } finally {
      setIsTestingOpenAi(false);
    }
  };

  // Add model from form
  const handleAddModel = () => {
    const pm = PROVIDER_META[addForm.provider];
    const displayName = pm.label;
    const model = addForm.provider === 'tavily' ? 'Tavily' : addForm.model.trim();
    if (addForm.provider !== 'tavily' && !model) return;

    const newConfig: ModelConfig = {
      id: crypto.randomUUID(),
      provider: addForm.provider,
      displayName,
      model,
      ...(addForm.apiKey.trim() ? { apiKey: addForm.apiKey.trim() } : {}),
      ...(addForm.provider === 'openai' && addForm.url ? { url: addForm.url } : {}),
    };

    const newList = [...modelList, newConfig];
    setModelList(newList);
    persistModelList(newList);
    setAddForm(DEFAULT_FORM);
    setShowAddForm(false);
  };

  // Delete model
  const handleDeleteModel = (id: string) => {
    const newList = modelList.filter(m => m.id !== id);
    setModelList(newList);
    persistModelList(newList);
  };

  const handleChangeLibrary = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: '选择新的灵感库根目录' });
      if (selected && typeof selected === 'string') {
        if (selected === libraryRoot) return;
        const confirmed = await showConfirm({
          title: '切换灵感库',
          message: '确定要切换到新的灵感库吗？当前列表会重新加载，但不会清空原灵感库的数据。',
          confirmText: '切换',
          cancelText: '取消',
        });
        if (!confirmed) return;
        await invoke('set_library_root', { path: selected });
        setLibraryRoot(selected);
        await invoke('scan_library');
      }
    } catch (err) {
      console.error('[Preferences] handleChangeLibrary error:', err);
    }
  };

  const handleRescanLibrary = async () => {
    if (!libraryRoot) return;
    setIsRescanning(true);
    try {
      await invoke('rescan_library');
    } catch (err) {
      console.error('[Preferences] handleRescanLibrary error:', err);
    } finally {
      setIsRescanning(false);
    }
  };

  const handleRehydrateMetadata = async () => {
    setIsRehydrating(true);
    setRehydrateStatus(null);
    try {
      const result = await invoke<string>('rehydrate_all_media_metadata');
      setRehydrateStatus(result);
      window.dispatchEvent(new CustomEvent('bookmarks-updated'));
    } catch (err) {
      console.error('[Preferences] handleRehydrateMetadata error:', err);
      setRehydrateStatus('补齐失败');
    } finally {
      setIsRehydrating(false);
    }
  };

  // ──────────────────────────────────────────────
  // Style helpers
  // ──────────────────────────────────────────────

  const sectionTitleStyle: React.CSSProperties = {
    fontFamily: 'var(--font-family)',
    fontSize: '12px',
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    margin: 0,
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 12px',
    backgroundColor: 'var(--bg-primary)',
    border: 'none',
    borderRadius: 'var(--radius-default)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-family)',
    fontSize: '13px',
    outline: 'none',
    boxShadow: 'inset 0 0 0 1px var(--border)',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '11px',
    color: 'var(--text-muted)',
    marginBottom: '8px',
    fontFamily: 'var(--font-family)',
  };

  // ──────────────────────────────────────────────
  // Can confirm add?
  // ──────────────────────────────────────────────

  const canAdd = (() => {
    if (addForm.provider !== 'tavily' && !addForm.model.trim()) return false;
    if (addForm.provider === 'openai' && !isOpenAiChatModel(addForm.model.trim())) return false;
    return true;
  })();

  // ──────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────

  return (
    <>
      {/* 遮罩 */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'var(--overlay-backdrop)',
          zIndex: 1000,
          opacity: isClosing ? 0 : 1,
          transition: 'opacity 150ms ease',
        }}
        onClick={handleCloseWithAnimation}
      />

      {/* 弹窗 */}
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: isClosing ? 'translate(-50%, -50%) scale(0.95)' : 'translate(-50%, -50%) scale(1)',
          opacity: isClosing ? 0 : 1,
          width: 480,
          maxHeight: '80vh',
          overflowY: 'auto',
          scrollbarWidth: 'none',
          backgroundColor: 'var(--bg-surface)',
          borderRadius: 'var(--radius-default)',
          boxShadow: 'var(--shadow-lg)',
          zIndex: 1001,
          padding: 24,
          fontFamily: 'var(--font-family)',
          transition: 'opacity 150ms ease, transform 150ms ease',
        }}
      >
        {/* 顶部标题 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <h2 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>首选项</h2>
          <button
            onClick={handleCloseWithAnimation}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, background: 'transparent', border: 'none', borderRadius: '50%', cursor: 'pointer', transition: 'background 150ms ease' }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--bg-hover)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
          >
            <Icon name="close" size={20} color="var(--text-secondary)" />
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

          {/* ── 灵感库位置 ── */}
          <section>
            <h3 style={{ ...sectionTitleStyle, marginBottom: 12 }}>灵感库位置</h3>
            {isLoading ? (
              <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>加载中...</p>
            ) : libraryRoot ? (
              <div style={{ backgroundColor: 'var(--bg-primary)', borderRadius: 'var(--radius-default)', padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
                <p style={{ fontFamily: 'var(--font-family)', fontSize: '13px', color: 'var(--text-primary)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }} title={libraryRoot}>
                  {libraryRoot}
                </p>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={handleRescanLibrary}
                    disabled={isRescanning}
                    style={{ padding: '8px 12px', backgroundColor: 'var(--bg-hover)', border: 'none', borderRadius: 'var(--radius-default)', color: 'var(--text-primary)', fontFamily: 'var(--font-family)', fontSize: '13px', cursor: isRescanning ? 'not-allowed' : 'pointer', opacity: isRescanning ? 0.6 : 1, whiteSpace: 'nowrap', transition: 'all var(--transition-default)' }}
                    onMouseEnter={e => { if (!isRescanning) { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-on-accent)'; } }}
                    onMouseLeave={e => { if (!isRescanning) { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--bg-hover)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)'; } }}
                  >
                    {isRescanning ? '扫描中...' : '重新扫描'}
                  </button>
                  <button
                    onClick={handleChangeLibrary}
                    style={{ padding: '8px 12px', backgroundColor: 'var(--bg-hover)', border: 'none', borderRadius: 'var(--radius-default)', color: 'var(--text-primary)', fontFamily: 'var(--font-family)', fontSize: '13px', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'all var(--transition-default)' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--accent)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-on-accent)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--bg-hover)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)'; }}
                  >
                    更改
                  </button>
                </div>
              </div>
            ) : (
              <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>未配置灵感库</p>
            )}
          </section>

          {/* ── AI 模型配置 ── */}
          <section>
            {/* 标题 + 添加按钮 */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={sectionTitleStyle}>模型</h3>
              <button
                onClick={() => { setShowAddForm(v => !v); if (showAddForm) { setAddForm(DEFAULT_FORM); } }}
                style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 12px', backgroundColor: 'transparent', border: 'none', borderRadius: 'var(--radius-default)', color: showAddForm ? 'var(--text-secondary)' : 'var(--accent)', fontSize: '12px', fontFamily: 'var(--font-family)', cursor: 'pointer', boxShadow: `inset 0 0 0 1px ${showAddForm ? 'var(--border)' : 'color-mix(in srgb, var(--accent) 35%, transparent)'}`, transition: 'all 150ms ease' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = showAddForm ? 'var(--bg-hover)' : 'color-mix(in srgb, var(--accent) 10%, transparent)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
              >
                {showAddForm ? '取消' : '+ 添加'}
              </button>
            </div>

            {/* 模型列表 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {modelList.length === 0 && !showAddForm && (
                <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px', fontFamily: 'var(--font-family)' }}>
                  还没有配置模型，点击「+ 添加」开始
                </div>
              )}
              {modelList.map(config => (
                <div
                  key={config.id}
                  style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', backgroundColor: 'var(--bg-primary)', borderRadius: 'var(--radius-default)' }}
                >
                  {/* 圆形字母图标 */}
                  <div style={{ width: '28px', height: '28px', borderRadius: '50%', backgroundColor: 'var(--bg-hover)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)', flexShrink: 0 }}>
                    {getProviderLetter(config)}
                  </div>
                  {/* 名称 · 模型 */}
                  <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span style={{ fontSize: '13px', color: 'var(--text-primary)', fontFamily: 'var(--font-family)', fontWeight: 500 }}>
                      {config.displayName}
                    </span>
                    <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontFamily: 'var(--font-family)' }}>
                      {' · '}{config.model}
                    </span>
                  </div>
                  {/* 删除 */}
                  <button
                    onClick={() => handleDeleteModel(config.id)}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '28px', height: '28px', background: 'transparent', border: 'none', borderRadius: '50%', cursor: 'pointer', flexShrink: 0, transition: 'background 150ms ease' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'color-mix(in srgb, var(--error) 15%, transparent)'; }}
                    onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent'; }}
                  >
                    <Icon name="delete" size={16} color="var(--text-muted)" />
                  </button>
                </div>
              ))}
            </div>

            {/* 添加表单 */}
            {showAddForm && (
              <div style={{ marginTop: '8px', backgroundColor: 'var(--bg-primary)', borderRadius: 'var(--radius-default)', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>

                {/* 提供商 */}
                <div>
                  <label style={labelStyle}>提供商</label>
                  <select
                    value={addForm.provider}
                    onChange={e => {
                      const p = e.target.value as ModelConfig['provider'];
                      const defaultUrl = p === 'openai' ? 'http://127.0.0.1:8317/v1' : '';
                      const defaultModel = p === 'openai' ? 'gpt-5.5-high' : '';
                      setAddForm(() => ({ ...DEFAULT_FORM, provider: p, url: defaultUrl, model: defaultModel }));
                      setOpenAiModels([]);
                      setOpenAiTestStatus('idle');
                    }}
                    style={{ ...inputStyle, appearance: 'none', WebkitAppearance: 'none' }}
                  >
                    <option value="openai">OpenAI-compatible（本机）</option>
                    <option value="claude">Claude（Anthropic）</option>
                    <option value="bailian">百炼（阿里云）</option>
                    <option value="tavily">联网搜索（Tavily）</option>
                  </select>
                </div>

                {/* 服务地址 */}
                {addForm.provider === 'openai' && (
                  <div>
                    <label style={labelStyle}>服务地址</label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input
                        type="text"
                        value={addForm.url}
                        onChange={e => setAddForm(f => ({ ...f, url: e.target.value }))}
                        placeholder="http://127.0.0.1:8317/v1"
                        style={{ ...inputStyle, flex: 1 }}
                      />
                      {addForm.provider === 'openai' && (
                        <button
                          onClick={handleTestOpenAiInForm}
                          disabled={isTestingOpenAi}
                          style={{ padding: '0 12px', backgroundColor: 'var(--bg-hover)', border: 'none', borderRadius: 'var(--radius-default)', color: openAiTestStatus === 'success' ? 'var(--success)' : openAiTestStatus === 'error' ? 'var(--error)' : 'var(--text-primary)', fontSize: '12px', fontFamily: 'var(--font-family)', cursor: isTestingOpenAi ? 'not-allowed' : 'pointer', opacity: isTestingOpenAi ? 0.5 : 1, whiteSpace: 'nowrap', boxShadow: 'inset 0 0 0 1px var(--border)' }}
                        >
                          {isTestingOpenAi ? '测试中...' : openAiTestStatus === 'success' ? '已连接' : openAiTestStatus === 'error' ? '失败' : '测试连接'}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* API Key */}
                {PROVIDER_META[addForm.provider]?.needsKey && (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                      <label style={{ ...labelStyle, marginBottom: 0 }}>API Key</label>
                      {addForm.provider === 'tavily' && (
                        <a href="https://tavily.com" target="_blank" rel="noreferrer" style={{ fontSize: '11px', color: 'var(--accent)', textDecoration: 'none', fontFamily: 'var(--font-family)' }}>免费申请 →</a>
                      )}
                    </div>
                    <div style={{ position: 'relative' }}>
                      <input
                        type={addForm.showKey ? 'text' : 'password'}
                        value={addForm.apiKey}
                        onChange={e => setAddForm(f => ({ ...f, apiKey: e.target.value }))}
                        placeholder={
                          addForm.provider === 'claude' ? 'sk-ant-xxxxxxxx' :
                          addForm.provider === 'openai' ? '留空时使用环境变量或本机 key 文件' :
                          addForm.provider === 'tavily' ? 'tvly-xxxxxxxx' : 'sk-xxxxxxxx'
                        }
                        style={{ ...inputStyle, paddingRight: '40px' }}
                      />
                      <Icon
                        name={addForm.showKey ? 'visibility_off' : 'visibility'}
                        size={18}
                        onClick={() => setAddForm(f => ({ ...f, showKey: !f.showKey }))}
                        style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', cursor: 'pointer' }}
                      />
                    </div>
                  </div>
                )}

                {/* 模型（非 Tavily） */}
                {addForm.provider !== 'tavily' && (
                  <div>
                    <label style={labelStyle}>模型</label>
                    {addForm.provider === 'openai' && openAiModels.length > 0 ? (
                      <select
                        value={addForm.model}
                        onChange={e => setAddForm(f => ({ ...f, model: e.target.value }))}
                        style={{ ...inputStyle, appearance: 'none', WebkitAppearance: 'none' }}
                      >
                        {openAiModels.map(m => <option key={m} value={m}>{m}</option>)}
                      </select>
                    ) : (
                      <>
                        <input
                          type="text"
                          value={addForm.model}
                          onChange={e => setAddForm(f => ({ ...f, model: e.target.value }))}
                          placeholder={
                            addForm.provider === 'openai'  ? 'gpt-5.5-high' :
                            addForm.provider === 'claude'  ? 'claude-sonnet-4-6' :
                            addForm.provider === 'bailian' ? 'qwen-plus' : '模型名称'
                          }
                          style={inputStyle}
                        />
                      </>
                    )}
                  </div>
                )}

                {/* 确认添加 */}
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    onClick={handleAddModel}
                    disabled={!canAdd}
                    style={{ padding: '8px 20px', background: canAdd ? 'linear-gradient(135deg, var(--accent-dim), var(--accent))' : 'var(--bg-hover)', border: 'none', borderRadius: 'var(--radius-default)', color: canAdd ? 'var(--text-on-accent)' : 'var(--text-muted)', fontFamily: 'var(--font-family)', fontSize: '13px', fontWeight: 600, cursor: canAdd ? 'pointer' : 'not-allowed', transition: 'all 150ms ease' }}
                  >
                    确认添加
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* ── 旧数据补齐 ── */}
          <section>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={sectionTitleStyle}>旧数据补齐</h3>
              <button
                onClick={handleRehydrateMetadata}
                disabled={isRehydrating}
                style={{ padding: '4px 12px', backgroundColor: 'transparent', border: 'none', borderRadius: 'var(--radius-default)', color: 'var(--accent)', fontSize: '12px', fontFamily: 'var(--font-family)', cursor: isRehydrating ? 'not-allowed' : 'pointer', opacity: isRehydrating ? 0.6 : 1, boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent)', transition: 'all 150ms ease' }}
              >
                {isRehydrating ? '补齐中...' : '开始补齐'}
              </button>
            </div>
            <div style={{ backgroundColor: 'var(--bg-primary)', borderRadius: 'var(--radius-default)', padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <p style={{ fontFamily: 'var(--font-family)', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
                {rehydrateDescription}
              </p>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontFamily: 'var(--font-family)', fontSize: '13px', color: 'var(--text-secondary)' }}>补齐内容</span>
                <span style={{ fontFamily: 'var(--font-family)', fontSize: '13px', color: 'var(--text-primary)' }}>缩略图 / 颜色 / Hash / 尺寸</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontFamily: 'var(--font-family)', fontSize: '13px', color: 'var(--text-secondary)' }}>状态</span>
                <span style={{ fontFamily: 'var(--font-family)', fontSize: '13px', color: 'var(--text-primary)' }}>{rehydrateSummary}</span>
              </div>
            </div>
          </section>

          {/* ── 关于 ── */}
          <section>
            <h3 style={{ ...sectionTitleStyle, marginBottom: 12 }}>关于</h3>
            <div style={{ backgroundColor: 'var(--bg-primary)', borderRadius: 'var(--radius-default)', padding: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontFamily: 'var(--font-family)', fontSize: '13px', color: 'var(--text-secondary)' }}>软件名称</span>
                <span style={{ fontFamily: 'var(--font-family)', fontSize: '13px', color: 'var(--text-primary)' }}>Gega Gallery</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontFamily: 'var(--font-family)', fontSize: '13px', color: 'var(--text-secondary)' }}>版本号</span>
                <span style={{ fontFamily: 'var(--font-family)', fontSize: '13px', color: 'var(--text-primary)' }}>v{appVersion}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontFamily: 'var(--font-family)', fontSize: '13px', color: 'var(--text-secondary)' }}>技术栈</span>
                <span style={{ fontFamily: 'var(--font-family)', fontSize: '13px', color: 'var(--text-primary)' }}>Tauri + React + TypeScript</span>
              </div>
            </div>
          </section>

        </div>
      </div>
    </>
  );
};
