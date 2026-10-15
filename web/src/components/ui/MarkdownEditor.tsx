// Markdown text editor: auto-growing textarea with Write / Preview modes and a small
// formatting toolbar. mod+Enter submits, Esc cancels (while focused), Enter continues lists,
// mod+B / mod+I toggle bold / italic. Edits go through execCommand so native undo works.

import { useMergeRefs } from '@floating-ui/react';
import { clsx } from 'clsx';
import { Bold, Code, Italic, Link2, List, ListChecks, ListOrdered } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { useOverlay } from '../../lib/overlays';
import { IconButton } from './Button';
import { CONTROL_SURFACE_WITHIN } from './controlStyles';
import { useFieldControl } from './Field';
import { Markdown } from './Markdown';
import {
  applyTextEdit,
  continueList,
  insertLink,
  toggleInline,
  toggleLinePrefix,
  type InlineFormat,
  type LineFormat,
  type TextEdit,
} from './markdownFormat';
import { SegmentedControl } from './SegmentedControl';
import { formatShortcut } from './shortcuts';
import { useAutosize } from './Textarea';

export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** mod+Enter (⌘↵ / Ctrl+Enter). */
  onSubmit?: () => void;
  /** Esc while the editor has focus (does not close an enclosing dialog/drawer). */
  onCancel?: () => void;
  placeholder?: string;
  /** Default 4. */
  minRows?: number;
  /** Rows before the textarea scrolls (default 20; 0 = unlimited). */
  maxRows?: number;
  autoFocus?: boolean;
  disabled?: boolean;
  maxLength?: number;
  /** Formatting buttons (default true). */
  toolbar?: boolean;
  /** Right side of the bottom bar, typically Cancel / Save buttons. */
  actions?: ReactNode;
  'aria-label'?: string;
  id?: string;
  textareaRef?: Ref<HTMLTextAreaElement>;
  className?: string;
}

type Mode = 'write' | 'preview';

export function MarkdownEditor({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder = 'Write something… (Markdown supported)',
  minRows = 4,
  maxRows = 20,
  autoFocus,
  disabled,
  maxLength,
  toolbar = true,
  actions,
  'aria-label': ariaLabel,
  id,
  textareaRef,
  className,
}: MarkdownEditorProps) {
  const field = useFieldControl({ id });
  const [mode, setMode] = useState<Mode>('write');
  const [focused, setFocused] = useState(false);
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const ref = useMergeRefs([inner, textareaRef]);
  const pendingSelection = useRef<[number, number] | null>(null);
  const lastHeight = useRef<number>(0);

  useAutosize(inner, mode === 'write', minRows, maxRows, value);

  // Esc cancels only while focused; registering as an overlay makes this the top Esc handler.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  // Blurring afterwards lets a second Esc reach the enclosing dialog/drawer.
  useOverlay(focused && !!onCancel, () => {
    onCancelRef.current?.();
    inner.current?.blur();
  });

  useLayoutEffect(() => {
    const sel = pendingSelection.current;
    const el = inner.current;
    if (sel && el) {
      el.setSelectionRange(sel[0], sel[1]);
      pendingSelection.current = null;
    }
  }, [value]);

  const apply = (edit: TextEdit) => {
    const el = inner.current;
    if (!el || disabled) return;
    const expected = applyTextEdit(el.value, edit);
    el.focus();
    el.setSelectionRange(edit.from, edit.to);
    let ok = false;
    try {
      if (edit.insert !== '') ok = document.execCommand('insertText', false, edit.insert);
      else ok = edit.from === edit.to || document.execCommand('delete');
    } catch {
      ok = false;
    }
    if (ok && el.value === expected) {
      el.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    } else {
      // No execCommand support (or it produced something else): controlled update.
      pendingSelection.current = [edit.selectionStart, edit.selectionEnd];
      onChange(expected);
    }
  };

  const selection = (): [number, number] => {
    const el = inner.current;
    return el ? [el.selectionStart, el.selectionEnd] : [value.length, value.length];
  };
  const inline = (format: InlineFormat) => {
    const [s, e] = selection();
    apply(toggleInline(inner.current?.value ?? value, s, e, format));
  };
  const linePrefix = (format: LineFormat) => {
    const [s, e] = selection();
    apply(toggleLinePrefix(inner.current?.value ?? value, s, e, format));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'Enter') {
      if (onSubmit) {
        e.preventDefault();
        onSubmit();
      }
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'b' || e.key === 'B' || e.key === 'i' || e.key === 'I')) {
      e.preventDefault();
      inline(e.key.toLowerCase() === 'b' ? 'bold' : 'italic');
      return;
    }
    if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey) {
      const [s, end] = selection();
      const edit = continueList(e.currentTarget.value, s, end);
      if (edit) {
        e.preventDefault();
        apply(edit);
      }
    }
  };

  const switchMode = (next: Mode) => {
    if (next === 'preview' && inner.current) lastHeight.current = inner.current.offsetHeight;
    setMode(next);
    if (next === 'write') requestAnimationFrame(() => inner.current?.focus());
  };

  // `desktopOnly` tools are hidden on phones so the toolbar fits next to Write / Preview.
  const tools: Array<{ label: string; icon: ReactNode; run: () => void; shortcut?: string; desktopOnly?: boolean }> = [
    { label: 'Bold', icon: <Bold />, run: () => inline('bold'), shortcut: 'mod+b' },
    { label: 'Italic', icon: <Italic />, run: () => inline('italic'), shortcut: 'mod+i' },
    { label: 'Code', icon: <Code />, run: () => inline('code'), desktopOnly: true },
    { label: 'Link', icon: <Link2 />, run: () => apply(insertLink(inner.current?.value ?? value, ...selection())) },
    { label: 'Bulleted list', icon: <List />, run: () => linePrefix('bullet') },
    { label: 'Numbered list', icon: <ListOrdered />, run: () => linePrefix('number'), desktopOnly: true },
    { label: 'Checklist', icon: <ListChecks />, run: () => linePrefix('task') },
  ];
  const showFooter = !!actions || !!onSubmit;

  return (
    <div className={clsx('flex min-w-0 flex-col', CONTROL_SURFACE_WITHIN, disabled && 'opacity-60', className)}>
      <div className="flex min-w-0 items-center gap-2 border-b border-border px-1.5 py-1">
        <SegmentedControl<Mode>
          size="sm"
          aria-label="Editor mode"
          value={mode}
          onChange={switchMode}
          options={[
            { value: 'write', label: 'Write' },
            { value: 'preview', label: 'Preview' },
          ]}
        />
        {toolbar && mode === 'write' && (
          <div role="toolbar" aria-label="Formatting" className="touch-scroll-x no-scrollbar -my-0.5 ml-auto flex min-w-0 items-center">
            {tools.map((t) => (
              <IconButton
                key={t.label}
                size="sm"
                aria-label={t.label}
                tooltip={t.shortcut ? `${t.label} (${formatShortcut(t.shortcut)})` : t.label}
                icon={t.icon}
                disabled={disabled}
                // Keep the textarea selection when clicking a tool.
                onMouseDown={(e) => e.preventDefault()}
                onClick={t.run}
                className={clsx('max-md:size-9', t.desktopOnly && 'max-md:hidden')}
              />
            ))}
          </div>
        )}
      </div>
      {mode === 'write' ? (
        <textarea
          ref={ref}
          aria-label={ariaLabel}
          {...field}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          disabled={disabled}
          maxLength={maxLength}
          rows={minRows}
          className="block w-full min-w-0 resize-none bg-transparent px-3 py-2.5 text-sm leading-relaxed text-fg outline-none placeholder:text-fg-subtle"
        />
      ) : (
        <div className="min-w-0 px-3 py-2.5 text-sm" style={{ minHeight: lastHeight.current || undefined }}>
          {value.trim() ? <Markdown source={value} /> : <p className="text-fg-subtle">Nothing to preview</p>}
        </div>
      )}
      {showFooter && (
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 border-t border-border px-2 py-1.5">
          {onSubmit && (
            <span className="mr-auto pl-1 text-xs text-fg-subtle pointer-coarse:hidden">{formatShortcut('mod+enter')} to save</span>
          )}
          {actions}
        </div>
      )}
    </div>
  );
}
