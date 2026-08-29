"use client";

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ComponentProps } from 'react';
import { en, zh } from '@blocknote/core/locales';
import { filterSuggestionItems } from '@blocknote/core';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import {
  AddBlockButton,
  blockTypeSelectItems,
  DragHandleButton,
  getFormattingToolbarItems,
  FormattingToolbar,
  FormattingToolbarController,
  getDefaultReactSlashMenuItems,
  SideMenu,
  SideMenuController,
  SuggestionMenuController,
  type DefaultReactSuggestionItem,
  type SideMenuProps,
  type SuggestionMenuProps,
} from '@blocknote/react';
import '@blocknote/shadcn/style.css';
import '@blocknote/core/fonts/inter.css';
import { useLanguage } from '@/contexts/LanguageContext';

export interface UnifiedMarkdownEditorRef {
  getMarkdown: () => Promise<string>;
  focus: () => void;
  appendMarkdown: (markdown: string) => Promise<string>;
  setMarkdown: (markdown: string) => Promise<void>;
  runCommand: (command: 'undo' | 'redo' | 'bold' | 'italic' | 'underline' | 'strike' | 'highlight' | 'paragraph' | 'heading' | 'heading2' | 'heading3' | 'heading4' | 'bulletList' | 'numberedList' | 'checkList' | 'quote' | 'link', value?: string) => void;
  replaceAll: (from: string, to: string) => Promise<{ count: number; markdown: string }>;
}

interface UnifiedMarkdownEditorProps {
  documentKey: string;
  value: string;
  placeholder: string;
  onChange: (markdown: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  compact?: boolean;
}

type FormattingFloatingOptions = NonNullable<
  ComponentProps<typeof FormattingToolbarController>['floatingOptions']
> & {
  canDismiss: {
    enabled: boolean;
    escapeKey: boolean;
    outsidePress: (event: MouseEvent) => boolean;
  };
};

type CompactBlockTypeItem = ReturnType<typeof blockTypeSelectItems>[number];

function CompactBlockMenu({
  block,
  editor,
  items,
}: {
  block: SideMenuProps['block'];
  editor: SideMenuProps['editor'];
  items: CompactBlockTypeItem[];
}) {
  const { locale } = useLanguage();
  const headingItems = items.filter(item => item.type === 'paragraph' || item.type === 'heading');
  const structureItems = items.filter(item => !headingItems.includes(item));
  const renderItems = (sectionItems: CompactBlockTypeItem[]) => (
    <div className="calmee-insert-menu-grid">
      {sectionItems.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={`${item.type}-${JSON.stringify(item.props || {})}`}
            type="button"
            aria-label={item.name}
            title={item.name}
            className={`calmee-insert-menu-item ${item.isSelected(block as any) ? 'calmee-insert-menu-item--selected' : ''}`}
            onClick={() => {
              editor.updateBlock(block, { type: item.type as any, props: item.props as any });
              editor.focus();
            }}
          >
            <span className="calmee-insert-menu-icon"><Icon /></span>
          </button>
        );
      })}
    </div>
  );
  return (
    <div className="calmee-insert-menu" role="menu" aria-label={locale === 'zh-CN' ? '内容块格式' : 'Block format'}>
      <section className="calmee-insert-menu-section" aria-label={locale === 'zh-CN' ? '文本结构' : 'Text structure'}>
        {renderItems(headingItems)}
      </section>
      <section className="calmee-insert-menu-section" aria-label={locale === 'zh-CN' ? '列表与引用' : 'Lists and quote'}>
        {renderItems(structureItems)}
      </section>
    </div>
  );
}

function CompactSideMenu({ items, ...props }: SideMenuProps & { items: CompactBlockTypeItem[] }) {
  return (
    <SideMenu {...props}>
      <AddBlockButton block={props.block} />
      <DragHandleButton {...props}>
        <CompactBlockMenu block={props.block} editor={props.editor} items={items} />
      </DragHandleButton>
    </SideMenu>
  );
}

function CompactSuggestionMenu({
  items,
  loadingState,
  selectedIndex,
  onItemClick,
}: SuggestionMenuProps<DefaultReactSuggestionItem>) {
  const { locale } = useLanguage();
  if (loadingState !== 'loaded' && items.length === 0) return null;

  const headingItems = items.filter((item) =>
    /heading|标题|paragraph|正文|text/i.test(item.title),
  );
  const structureItems = items.filter((item) => !headingItems.includes(item));

  const renderItems = (sectionItems: DefaultReactSuggestionItem[]) => (
    <div className="calmee-insert-menu-grid">
      {sectionItems.map((item) => {
        const index = items.indexOf(item);
        return (
          <button
            key={`${item.title}-${index}`}
            type="button"
            role="option"
            aria-selected={selectedIndex === index}
            aria-label={item.title}
            title={item.title}
            className="calmee-insert-menu-item"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onItemClick?.(item)}
          >
            <span className="calmee-insert-menu-icon">{item.icon}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div
      className="calmee-insert-menu"
      role="listbox"
      aria-label={locale === 'zh-CN' ? '插入内容' : 'Insert content'}
    >
      {headingItems.length > 0 && (
        <section role="group" className="calmee-insert-menu-section" aria-label={locale === 'zh-CN' ? '文本结构' : 'Text structure'}>
          {renderItems(headingItems)}
        </section>
      )}
      {structureItems.length > 0 && (
        <section role="group" className="calmee-insert-menu-section" aria-label={locale === 'zh-CN' ? '列表与引用' : 'Lists and quote'}>
          {renderItems(structureItems)}
        </section>
      )}
    </div>
  );
}

function characterCount(markdown: string) {
  return Array.from(markdown.replace(/\s/g, '')).length;
}

export const UnifiedMarkdownEditor = forwardRef<UnifiedMarkdownEditorRef, UnifiedMarkdownEditorProps>(function UnifiedMarkdownEditor({
  documentKey, value, placeholder, onChange, onDirtyChange, compact = false,
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
    tabBehavior: 'prefer-indent',
    heading: { levels: [1, 2, 3, 4] },
  }, [documentKey, locale]);

  // BlockNote's public controller type currently omits `canDismiss`, although
  // the underlying positioning hook supports it. Radix mounts the style menu
  // in a portal, so explicitly keep that portal inside the editing interaction.
  const formattingFloatingOptions: FormattingFloatingOptions = useMemo(() => ({
    canDismiss: {
      enabled: true,
      escapeKey: true,
      outsidePress: (event: MouseEvent) => {
        const target = event.target;
        if (!(target instanceof Element)) return true;
        if (target.closest('.bn-select')) return false;
        return !editor.domElement?.parentElement?.contains(target);
      },
    },
  }), [editor]);

  const compactBlockTypeItems = useMemo(() => {
    const names = locale === 'zh-CN'
      ? {
          paragraph: '正文', heading1: '标题 1', heading2: '标题 2', heading3: '标题 3', heading4: '标题 4',
          bulletListItem: '项目符号', numberedListItem: '编号列表', checkListItem: '待办事项', quote: '引用',
        }
      : {
          paragraph: 'Body text', heading1: 'Heading 1', heading2: 'Heading 2', heading3: 'Heading 3', heading4: 'Heading 4',
          bulletListItem: 'Bulleted list', numberedListItem: 'Numbered list', checkListItem: 'Checklist', quote: 'Quote',
        };
    return blockTypeSelectItems(editor.dictionary)
      .filter((item) => {
        if (item.type === 'heading') {
          const level = Number(item.props?.level || 0);
          return !item.props?.isToggleable && level >= 1 && level <= 4;
        }
        return ['paragraph', 'quote', 'bulletListItem', 'numberedListItem', 'checkListItem'].includes(item.type);
      })
      .map((item) => {
        const key = item.type === 'heading'
          ? `heading${Number(item.props?.level || 1)}`
          : item.type;
        return { ...item, name: names[key as keyof typeof names] || item.name };
      });
  }, [editor, locale]);

  const compactSlashItems = useMemo(() => {
    const menu = editor.dictionary.slash_menu;
    const orderedTitles = [
      menu.paragraph.title,
      menu.heading.title,
      menu.heading_2.title,
      menu.heading_3.title,
      menu.heading_4.title,
      menu.bullet_list.title,
      menu.numbered_list.title,
      menu.check_list.title,
      menu.quote.title,
    ];
    const order = new Map(orderedTitles.map((title, index) => [title, index]));
    return getDefaultReactSlashMenuItems(editor)
      .filter((item) => order.has(item.title))
      .sort((left, right) => order.get(left.title)! - order.get(right.title)!);
  }, [editor]);
  const compactSideMenu = useMemo(
    () => function CalMeeSideMenu(props: SideMenuProps) {
      return <CompactSideMenu {...props} items={compactBlockTypeItems} />;
    },
    [compactBlockTypeItems],
  );

  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { dirtyRef.current = onDirtyChange; }, [onDirtyChange]);
  useEffect(() => { valueRef.current = value; }, [value]);

  useEffect(() => {
    const element = editor.domElement;
    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
      let block;
      try {
        block = editor.getTextCursorPosition().block;
      } catch {
        return;
      }

      if (block.type === 'heading') {
        event.preventDefault();
        const level = Number(block.props.level || 1);
        if (event.shiftKey) {
          if (level > 1) editor.updateBlock(block, { type: 'heading', props: { level: (level - 1) as 1 | 2 | 3 | 4 } });
        } else if (level < 4) {
          editor.updateBlock(block, { type: 'heading', props: { level: (level + 1) as 1 | 2 | 3 | 4 } });
        } else {
          editor.updateBlock(block, { type: 'paragraph' });
        }
        editor.focus();
        return;
      }

      // A normal text block is the end of the heading-demotion chain. Lists
      // retain BlockNote's Notion-style Tab/Shift+Tab nesting behavior.
      if (block.type === 'paragraph') {
        event.preventDefault();
        if (event.shiftKey) {
          editor.updateBlock(block, { type: 'heading', props: { level: 4 } });
          editor.focus();
        }
      }
    };
    element?.addEventListener('keydown', handleTab, true);
    return () => element?.removeEventListener('keydown', handleTab, true);
  }, [editor]);

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
    appendMarkdown: async (addition) => {
      const current = await readMarkdown();
      const markdown = `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${addition}`;
      const blocks = await editor.tryParseMarkdownToBlocks(markdown);
      editor.replaceBlocks(editor.document, blocks.length ? blocks : [{ type: 'paragraph' }]);
      markdownRef.current = markdown;
      setCount(characterCount(markdown));
      dirtyRef.current?.(markdown.trim() !== initialRef.current.trim());
      onChangeRef.current(markdown);
      window.requestAnimationFrame(() => editor.focus());
      return markdown;
    },
    setMarkdown: async (markdown) => {
      if (markdown === markdownRef.current) return;
      const blocks = await editor.tryParseMarkdownToBlocks(markdown || '');
      editor.replaceBlocks(editor.document, blocks.length ? blocks : [{ type: 'paragraph' }]);
      markdownRef.current = markdown;
      setCount(characterCount(markdown));
    },
    runCommand: (command, value) => {
      if (command === 'undo') return void editor.undo();
      if (command === 'redo') return void editor.redo();
      if (command === 'bold') return void editor.toggleStyles({ bold: true });
      if (command === 'italic') return void editor.toggleStyles({ italic: true });
      if (command === 'underline') return void editor.toggleStyles({ underline: true });
      if (command === 'strike') return void editor.toggleStyles({ strike: true });
      if (command === 'highlight') return void editor.toggleStyles({ backgroundColor: 'yellow' });
      if (command === 'link') {
        if (value) editor.createLink(value);
        return;
      }
      const block = editor.getTextCursorPosition().block;
      if (command === 'paragraph') editor.updateBlock(block, { type: 'paragraph' });
      if (command === 'heading') editor.updateBlock(block, { type: 'heading', props: { level: 1 } });
      if (command === 'heading2') editor.updateBlock(block, { type: 'heading', props: { level: 2 } });
      if (command === 'heading3') editor.updateBlock(block, { type: 'heading', props: { level: 3 } });
      if (command === 'heading4') editor.updateBlock(block, { type: 'heading', props: { level: 4 } });
      if (command === 'bulletList') editor.updateBlock(block, { type: 'bulletListItem' });
      if (command === 'numberedList') editor.updateBlock(block, { type: 'numberedListItem' });
      if (command === 'checkList') editor.updateBlock(block, { type: 'checkListItem' });
      if (command === 'quote') editor.updateBlock(block, { type: 'quote' });
      editor.focus();
    },
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

  return <div className={`calmee-blocknote-editor calmee-editor-canvas relative h-full min-h-0 ${compact ? "calmee-blocknote-editor--compact" : ""}`}>
    <div ref={scrollContainerRef} className="calmee-editor-scroll h-full overflow-y-auto">
      <BlockNoteView
        editor={editor}
        editable
        theme="light"
        onChange={handleChange}
        sideMenu={false}
        slashMenu={false}
        formattingToolbar={false}
      >
        <SideMenuController sideMenu={compactSideMenu} />
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) => filterSuggestionItems(compactSlashItems, query)}
          suggestionMenuComponent={CompactSuggestionMenu}
        />
        <FormattingToolbarController
          floatingOptions={formattingFloatingOptions}
          formattingToolbar={() => (
            <FormattingToolbar>
              {getFormattingToolbarItems(compactBlockTypeItems)}
            </FormattingToolbar>
          )}
        />
      </BlockNoteView>
    </div>
    {!compact && <div className="pointer-events-none absolute bottom-7 right-5 z-20 rounded-lg border border-slate-100 bg-white/95 px-2.5 py-1 text-[11px] tabular-nums text-slate-500 shadow-sm backdrop-blur-sm">
      {locale === 'zh-CN' ? '字数' : 'Characters'}：{count.toLocaleString()}
    </div>}
  </div>;
});
