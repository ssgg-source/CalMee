"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { en, zh } from '@blocknote/core/locales';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import '@blocknote/shadcn/style.css';
import '@blocknote/core/fonts/inter.css';
import { useLanguage } from '@/contexts/LanguageContext';

export interface UnifiedMarkdownEditorRef {
  getMarkdown: () => Promise<string>;
  focus: () => void;
  replaceAll: (from: string, to: string) => Promise<{ count: number; markdown: string }>;
}

interface UnifiedMarkdownEditorProps {
  documentKey: string;
  value: string;
  placeholder: string;
  onChange: (markdown: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

function characterCount(markdown: string) {
  return Array.from(markdown.replace(/\s/g, '')).length;
}

export const UnifiedMarkdownEditor = forwardRef<UnifiedMarkdownEditorRef, UnifiedMarkdownEditorProps>(function UnifiedMarkdownEditor({
  documentKey, value, placeholder, onChange, onDirtyChange,
}, ref) {
  const { locale } = useLanguage();
  const initialRef = useRef(value);
  const markdownRef = useRef(value);
  const valueRef = useRef(value);
  const loadedRef = useRef(false);
  const conversionRef = useRef(0);
  const onChangeRef = useRef(onChange);
  const dirtyRef = useRef(onDirtyChange);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [count, setCount] = useState(() => characterCount(value));

  const editor = useCreateBlockNote({
    dictionary: locale === 'zh-CN' ? zh : en,
    placeholders: { default: placeholder },
  }, [documentKey, locale]);

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { dirtyRef.current = onDirtyChange; }, [onDirtyChange]);
  useEffect(() => { valueRef.current = value; }, [value]);

  useEffect(() => {
    let live = true;
    loadedRef.current = false;
    const source = valueRef.current;
    initialRef.current = source;
    markdownRef.current = source;
    setCount(characterCount(source));
    void editor.tryParseMarkdownToBlocks(source || '').then(blocks => {
      if (!live) return;
      editor.replaceBlocks(editor.document, blocks.length ? blocks : [{ type: 'paragraph' }]);
      markdownRef.current = source;
      window.requestAnimationFrame(() => { if (live) loadedRef.current = true; });
    }).catch(error => {
      console.error('Failed to load Markdown document', error);
      loadedRef.current = true;
    });
    return () => { live = false; loadedRef.current = false; };
  // The parent updates `value` as the user types. Reload only when the actual
  // document/editor identity changes, otherwise the cursor would jump.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentKey, editor]);

  const readMarkdown = async () => {
    try {
      const markdown = await editor.blocksToMarkdownLossy(editor.document);
      markdownRef.current = markdown;
      return markdown;
    } catch (error) {
      console.error('Failed to convert document to Markdown', error);
      return markdownRef.current;
    }
  };

  useImperativeHandle(ref, () => ({
    getMarkdown: readMarkdown,
    focus: () => editor.focus(),
    replaceAll: async (from, to) => {
      const scrollTop = scrollContainerRef.current?.scrollTop;
      const current = await readMarkdown();
      const count = from ? current.split(from).length - 1 : 0;
      if (!count) return { count: 0, markdown: current };
      const markdown = current.split(from).join(to);
      const blocks = await editor.tryParseMarkdownToBlocks(markdown);
      editor.replaceBlocks(editor.document, blocks.length ? blocks : [{ type: 'paragraph' }]);
      markdownRef.current = markdown;
      setCount(characterCount(markdown));
      dirtyRef.current?.(markdown.trim() !== initialRef.current.trim());
      onChangeRef.current(markdown);
      if (scrollTop !== undefined) {
        const restore = () => {
          if (scrollContainerRef.current)
            scrollContainerRef.current.scrollTop = scrollTop;
        };
        window.requestAnimationFrame(() => {
          restore();
          window.requestAnimationFrame(restore);
        });
      }
      return { count, markdown };
    },
  }), [editor]);

  const handleChange = () => {
    if (!loadedRef.current) return;
    const version = ++conversionRef.current;
    void editor.blocksToMarkdownLossy(editor.document).then(markdown => {
      if (version !== conversionRef.current) return;
      markdownRef.current = markdown;
      setCount(characterCount(markdown));
      dirtyRef.current?.(markdown.trim() !== initialRef.current.trim());
      onChangeRef.current(markdown);
    }).catch(error => console.error('Failed to update Markdown document', error));
  };

  return <div className="calmee-blocknote-editor relative h-full min-h-0 bg-white">
    <div ref={scrollContainerRef} className="h-full overflow-y-auto">
      <BlockNoteView editor={editor} editable theme="light" onChange={handleChange} />
    </div>
    <div className="pointer-events-none absolute bottom-7 right-5 z-20 rounded-lg border border-slate-100 bg-white/95 px-2.5 py-1 text-[11px] tabular-nums text-slate-500 shadow-sm backdrop-blur-sm">
      {locale === 'zh-CN' ? '字数' : 'Characters'}：{count.toLocaleString()}
    </div>
  </div>;
});
