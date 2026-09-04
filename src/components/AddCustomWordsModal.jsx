import { useState, useRef, useLayoutEffect, useEffect, useCallback } from 'react';
import { MODAL_SCRIM, MODAL_CARD, MODAL_TITLE, CTA_SOLO, CTA_OFF, BTN_M, PopClose, SCROLL_HIDE } from '../general-ui/popKit.jsx';
import { Icon } from '../general-ui/icons.jsx';
import { YELLOW } from '../general-ui/config.js';
import { CUSTOM_MAX_PER_BATCH, readDraft, writeDraft } from '../utils/customWords';

/* ── 自定义词组添加 pop ───────────────────────────────────────────
 * 交互定稿（用户 2026-09-03 拍板）：
 *  · 一条 = 竖着三行：① 英文 ② 中文 ③ 例句（选填）。整行铺开，不并排 ——
 *    并排两半太窄，长词组挤成三四行，读着累。
 *  · 例句**只有英文**：用户明确不要中文例句，也不要自动翻译。
 *  · 输入框自动长高 —— 一行装不下就自己换行，不裁字。
 *  · 一口气最多 10 条，但**不用点任何「再加一条」按钮**：只要最后一行开始有字，
 *    下面立刻自己续一张空行出来。常见的 1-2 条就是打完直接确认。
 *  · 从 Excel / 备忘录整段粘贴也认：带换行的粘贴自动拆成多行，
 *    一行里的 Tab 依次当作 英文 / 中文 / 英文例句。
 * popKit 的 X/Cancel 规矩：这是表单类 pop → 右上角一个 X + 底部一个 CTA，
 * 不加 Cancel。
 * 草稿边打边存：误触 X 或切走 app，重开还是原来那几行。 */

const emptyRow = () => ({ _k: Math.random().toString(36).slice(2), en: '', zh: '', sentence: '' });
const hasContent = (r) => !!(r.en || r.zh || r.sentence);
const isComplete = (r) => !!(r.en.trim() && r.zh.trim());
const isHalf = (r) => (!!r.en.trim()) !== (!!r.zh.trim());

function restoreDraft(scope) {
  const saved = readDraft(scope);
  if (!saved) return [emptyRow()];
  const rows = saved.slice(0, CUSTOM_MAX_PER_BATCH).map(r => ({
    ...emptyRow(),
    en: r.en || '', zh: r.zh || '', sentence: r.sentence || '',
  }));
  const last = rows[rows.length - 1];
  if (rows.length < CUSTOM_MAX_PER_BATCH && hasContent(last)) rows.push(emptyRow());
  return rows;
}

/* 自动长高的输入框：写死 rows=1 再按 scrollHeight 顶开，所以短词组就一行高，
 * 长词组自己换成两三行 —— 永远不出现横向滚动或被裁掉的半个词。 */
function GrowField({ value, onChange, onBlur, placeholder, fontSize = 14, minHeight = 34, onPaste, onEnter, english = false }) {
  const ref = useRef(null);
  const [focused, setFocused] = useState(false);

  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
  }, [minHeight]);

  useLayoutEffect(fit, [value, fit]);

  // 首帧量出来的 scrollHeight 不能信：字体还没从 fallback 换成 Nunito，
  // 一个空框会被量成三四行高，卡片一开就是四个大方块。下一帧 + 字体就位后
  // 各补量一次，形状才定得住。
  useEffect(() => {
    const raf = requestAnimationFrame(fit);
    let done = false;
    document.fonts?.ready?.then(() => { if (!done) fit(); }).catch(() => {});
    return () => { done = true; cancelAnimationFrame(raf); };
  }, [fit]);

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onPaste={onPaste}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        // 词组和例句都是单行内容，回车不该在框里换行 —— 直接跳下一个框。
        e.preventDefault();
        onEnter?.(e.currentTarget);
      }}
      onFocus={(e) => {
        setFocused(true);
        // 手机上键盘弹起会把下面的行顶出可视区，滚一下让正在打的框留在眼前。
        const el = e.currentTarget;
        setTimeout(() => { try { el.scrollIntoView({ block: 'nearest' }); } catch {} }, 260);
      }}
      onBlur={() => { setFocused(false); onBlur?.(); }}
      placeholder={placeholder}
      enterKeyHint="next"
      inputMode="text"
      autoComplete={english ? 'on' : 'off'}
      autoCorrect={english ? 'on' : 'off'}
      autoCapitalize={english ? 'sentences' : 'none'}
      spellCheck={english}
      style={{
        width: '100%', boxSizing: 'border-box', display: 'block',
        minHeight, padding: '7px 9px',
        background: '#fff',
        border: `1.5px solid ${focused ? YELLOW : '#DCD2CA'}`,
        borderRadius: 8,
        fontSize, lineHeight: 1.35, color: '#3A2E2E', fontFamily: 'inherit',
        resize: 'none', overflow: 'hidden', outline: 'none',
        transition: 'border-color .15s ease',
      }}
    />
  );
}

export default function AddCustomWordsModal({ scope, onClose, onSubmit, initialRow = null }) {
  const isEditing = !!initialRow;
  const [rows, setRows] = useState(() => initialRow
    ? [{ ...emptyRow(), en: initialRow.en || '', zh: initialRow.zh || '', sentence: initialRow.sentence || '' }]
    : restoreDraft(scope));
  const cardRef = useRef(null);

  // 草稿：手打十条最怕误触关掉，边打边存（防抖 300ms，别每个字符都写盘）。
  useEffect(() => {
    if (isEditing) return undefined;
    const id = setTimeout(() => {
      writeDraft(scope, rows.filter(hasContent).map(({ en, zh, sentence }) => ({ en, zh, sentence })));
    }, 300);
    return () => clearTimeout(id);
  }, [rows, scope, isEditing]);

  // 回车 = 跳到下一个输入框（最后一个就收键盘）。
  const focusNext = useCallback((el) => {
    const fields = Array.from(cardRef.current?.querySelectorAll('textarea') || []);
    const i = fields.indexOf(el);
    if (i >= 0 && i + 1 < fields.length) fields[i + 1].focus();
    else el.blur();
  }, []);

  // 改任意一格之后，如果最后一行已经有字，就自动续一张空行 ——
  // 「加第 2 条还得先点个按钮」正是用户点名不要的那种体验。
  const updateRow = useCallback((idx, patch) => {
    setRows(prev => {
      const next = prev.map((r, i) => (i === idx ? { ...r, ...patch } : r));
      if (!isEditing && next.length < CUSTOM_MAX_PER_BATCH && hasContent(next[next.length - 1])) next.push(emptyRow());
      return next;
    });
  }, [isEditing]);

  const removeRow = useCallback((idx) => {
    setRows(prev => {
      const next = prev.filter((_, i) => i !== idx);
      return next.length ? next : [emptyRow()];
    });
  }, []);

  // 整段粘贴：一行一条，行内 Tab 依次是 英文/中文/英文例句
  // （Excel 里框选几列复制出来就是这个格式）。从第 idx 行开始铺，超出 10 条截断。
  const handleBulkPaste = useCallback((idx) => (e) => {
    const text = e.clipboardData?.getData('text') || '';
    if (!/[\n\t]/.test(text)) return; // 普通粘贴，交给浏览器
    e.preventDefault();
    const parsed = text.split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean)
      .map(line => {
        const [en = '', zh = '', sentence = ''] = line.split('\t').map(s => s.trim());
        return { ...emptyRow(), en, zh, sentence };
      });
    if (!parsed.length) return;
    setRows(prev => {
      const limit = isEditing ? 1 : CUSTOM_MAX_PER_BATCH;
      const next = [...prev.slice(0, idx), ...parsed, ...prev.slice(idx + 1)].slice(0, limit);
      if (!isEditing && next.length < CUSTOM_MAX_PER_BATCH && hasContent(next[next.length - 1])) next.push(emptyRow());
      return next;
    });
  }, [isEditing]);

  const readyRows = rows.filter(isComplete);
  const halfCount = rows.filter(isHalf).length;
  const canSubmit = readyRows.length > 0;

  const CARD_SIDE = 'min(353px, calc(100vw - 48px))';

  return (
    <div style={{ ...MODAL_SCRIM, zIndex: 60 }} onClick={onClose}>
      <div
        ref={cardRef}
        className={SCROLL_HIDE}
        style={{
          ...MODAL_CARD,
          width: CARD_SIDE,
          minHeight: `min(${CARD_SIDE}, 100%)`, // 正方形下限 —— 内容再短也不压扁
          maxHeight: '100%',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          padding: '18px 14px 20px',
        }}
        onClick={e => e.stopPropagation()}
      >
        <PopClose onClick={onClose} label="关闭" />

        {/* ── 标题 ── */}
        <div style={{ flex: '0 0 auto', padding: '0 34px' }}>
          <h2 style={MODAL_TITLE}>{isEditing ? '编辑词组' : '自定义词组'}</h2>
        </div>

        {/* ── 词条列表（滚动区）── */}
        <div
          className={SCROLL_HIDE}
          style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          {rows.map((row, idx) => (
            <div
              key={row._k}
              style={{
                background: '#F8F4EF', border: '1.5px solid #E7DDD3', borderRadius: 12,
                padding: 8, position: 'relative',
              }}
            >
              {/* 行号 + 删除 */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 16, marginBottom: 5 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: '#b6a9ac', letterSpacing: 0.4 }}>{idx + 1}</span>
                {!isEditing && rows.length > 1 && (
                  <button
                    type="button" onClick={() => removeRow(idx)} aria-label={`删除第 ${idx + 1} 条`}
                    className="active:scale-90"
                    style={{ display: 'flex', alignItems: 'center', padding: 6, margin: -6, background: 'none', border: 'none' }}
                  >
                    <Icon name="close" size={13} color="#b6a9ac" stroke={2.2} />
                  </button>
                )}
              </div>

              {/* ① 英文 ② 中文 ③ 例句 —— 每行整宽铺开，各自独立长高 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <GrowField
                  value={row.en}
                  onChange={(v) => updateRow(idx, { en: v })}
                  onPaste={handleBulkPaste(idx)}
                  onEnter={focusNext}
                  placeholder="英文"
                  english
                />
                <GrowField
                  value={row.zh}
                  onChange={(v) => updateRow(idx, { zh: v })}
                  onEnter={focusNext}
                  placeholder="中文"
                />
                <GrowField
                  value={row.sentence}
                  onChange={(v) => updateRow(idx, { sentence: v })}
                  onEnter={focusNext}
                  placeholder="例句（选填）"
                  fontSize={13}
                  english
                />
              </div>
            </div>
          ))}
        </div>

        {/* ── 底部：一条状态 + 唯一 CTA ── */}
        <div style={{ flex: '0 0 auto', marginTop: 12 }}>
          <p style={{ margin: '0 0 8px', fontSize: 11.5, textAlign: 'center', lineHeight: 1.4, minHeight: 16, color: halfCount ? '#c98b8b' : '#9a8f92' }}>
            {halfCount
              ? `有 ${halfCount} 条只填了一半，不会被添加`
              : isEditing ? '修改后会自动保存并同步' : `${readyRows.length}/${CUSTOM_MAX_PER_BATCH} 条`}
          </p>
          <button
            type="button"
            onClick={() => canSubmit && onSubmit(readyRows)}
            disabled={!canSubmit}
            className={canSubmit ? 'active:scale-95' : ''}
            style={{
              ...(canSubmit ? CTA_SOLO : { ...CTA_OFF, ...BTN_M, alignSelf: 'center', maxWidth: '100%' }),
              display: 'flex', width: 178, margin: '0 auto',
            }}
          >
            {isEditing ? '保存修改' : canSubmit ? `添加 ${readyRows.length} 个词组` : '添加词组'}
          </button>
        </div>
      </div>
    </div>
  );
}
