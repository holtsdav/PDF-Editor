import { Component, Menu, Modal, Notice, Scope, setIcon, setTooltip } from 'obsidian';
import type { App } from 'obsidian';
import type { NativePage, NativePdf, EditorSurface } from '../compat/native-pdf';
import { pdfRectangle, screenRectangle } from '../compat/native-pdf';
import type { Rect, TextField, TextWidget } from '../pdf/text-engine';
import type { BackupKind } from '../pdf/recovery';
import { usePdfFont } from './pdf-font';
import type { CopiedPdfObject, PdfObject, TextSession } from '../pdf/text-session';
import { shiftShape } from '../pdf/text-session';
import type { VaultSessions } from '../pdf/vault-sessions';
import { growBox, rotatedHandle, transformBox } from '../pdf/box-geometry';
import type { ResizeHandle } from '../pdf/box-geometry';
import { ObjectSelection } from './object-selection';
import { InkLayer } from './ink-layer';
import type { EditorTool } from './ink-layer';
import { cssColor, fontFaces, normalizeSymbols } from '../pdf/text-format';
import type { FontFamily, PdfColor, TextFormat } from '../pdf/text-format';
import { RecoveryInfo } from './recovery-info';
import { RecoveryPreview } from './recovery-preview';
import { ToolPopover } from './tool-popover';
import { ruledAnswerBlock } from '../pdf/ruled-text';
import { labelOverlay } from './overlay-label';
import { setAttr, setProp, setStyle, setText } from './dom';
import type { ChoiceField, ChoiceWidget } from '../pdf/choice-engine';
import { isTextMark, lineQuads, textLine } from '../pdf/mark-engine';
import type { MarkKind, TextMarkKind } from '../pdf/mark-engine';
import { continueList, indent, toggleList } from '../pdf/list-format';
import type { TextEdit } from '../pdf/list-format';
import { ShapeLayer, shapeExtent } from './shape-layer';
import { hitsStroke } from '../pdf/ink-geometry';
import { ImageLayer } from './image-layer';
import { imageMime, imageSize, storedImage } from '../pdf/image-engine';
import type { PdfImage, QuarterTurn } from '../pdf/image-engine';
import type { ShapeStyle } from './shape-layer';
import type { PdfShape, ShapeKind } from '../pdf/shape-engine';
import { shapeRect } from '../pdf/shape-engine';

const SHAPE_KINDS: { kind: ShapeKind; label: string; icon: string }[] = [
  { kind: 'rectangle', label: 'Rectangle', icon: 'square' },
  { kind: 'ellipse', label: 'Ellipse', icon: 'circle' },
  { kind: 'line', label: 'Line', icon: 'minus' },
  { kind: 'arrow', label: 'Arrow', icon: 'move-up-right' },
];
const SHAPE_COLORS: { name: string; color: PdfColor }[] = [
  { name: 'Red', color: [0.85, 0.15, 0.15] },
  { name: 'Blue', color: [0.15, 0.4, 0.85] },
  { name: 'Green', color: [0.15, 0.6, 0.25] },
  { name: 'Orange', color: [0.95, 0.55, 0.1] },
  { name: 'Yellow', color: [1, 0.85, 0.1] },
  { name: 'Black', color: [0.1, 0.1, 0.1] },
];
const SHAPE_WIDTHS = [1, 2, 4];
import type { PdfMark } from '../pdf/mark-engine';

const MARK_COLORS: { name: string; color: PdfColor }[] = [
  { name: 'Yellow', color: [1, 0.85, 0.1] },
  { name: 'Green', color: [0.45, 0.9, 0.45] },
  { name: 'Blue', color: [0.45, 0.75, 1] },
  { name: 'Pink', color: [1, 0.55, 0.75] },
];
/** Colours for underline and strikeout lines (pale highlight colours would vanish). */
const LINE_COLORS: { name: string; color: PdfColor }[] = [
  { name: 'Red', color: [0.85, 0.15, 0.15] },
  { name: 'Blue', color: [0.15, 0.4, 0.85] },
  { name: 'Green', color: [0.15, 0.6, 0.25] },
  { name: 'Black', color: [0.1, 0.1, 0.1] },
];
const colorsFor = (kind: MarkKind) =>
  kind === 'underline' || kind === 'strikeout' ? LINE_COLORS : MARK_COLORS;
const MARK_UI = '.pfs-mark-ui';
/** Key names as the platform shows them: Ctrl+Shift+Z on Windows/Linux, ⌘⇧Z on macOS. */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export function keys(combo: string): string {
  if (!IS_MAC) {
    return combo.replace('Mod', 'Ctrl');
  }
  return combo
    .replace('Mod+', '⌘')
    .replace('Shift+', '⇧')
    .replace('Alt+', '⌥')
    .replace('Delete', '⌫');
}
const withKeys = (label: string, combo: string) => `${label} (${keys(combo)})`;
const TOOL_ACTIONS: EditorTool[] = [
  'select',
  'text',
  'marker',
  'scribble',
  'eraser',
  'note',
  'shape',
];
export type EditorAction = EditorTool | 'highlight' | 'underline' | 'strikeout' | 'insert-image';
type Point = [number, number];
type HighlightMode = 'toggle' | 'color' | 'comment';

interface AnswerLine {
  page: number;
  rect: Rect;
}
const objectClipboardType = 'application/x-pdf-editor-objects';
const webObjectClipboardType = `web ${objectClipboardType}`;
interface ObjectCopy {
  token: string;
  objects: CopiedPdfObject[];
  text: string;
  custom: boolean;
  blurred?: boolean;
  write?: Promise<void>;
}
let copiedObjects: ObjectCopy | undefined;
/** A shape copied with the context menu or Ctrl+C; cleared when objects are copied. */
let copiedShape: PdfShape | undefined;
/** The last picture copied here: a matching clipboard picture keeps its size and turn. */
let copiedImage: PdfImage | undefined;
type ContextTarget =
  | { kind: 'shape'; shape: PdfShape }
  | { kind: 'image'; image: PdfImage }
  | { kind: 'mark'; mark: PdfMark }
  | { kind: 'objects'; objects: PdfObject[] }
  | { kind: 'page' };
function objectClipboardHtml(doc: Document, text: string, token: string): string {
  const span = doc.createElement('span');
  span.dataset.pdfEditorObjects = token;
  span.textContent = text;
  // Semantic preformatting survives HTML clipboard transfer without inline CSS.
  // Nesting the span also preserves a leading newline when the HTML is parsed.
  const pre = doc.createElement('pre');
  pre.append(span);
  return pre.outerHTML;
}

interface FieldControl {
  frame: HTMLElement;
  input: HTMLInputElement | HTMLTextAreaElement;
  /** Inputs of the last layout write; refresh skips unchanged boxes. */
  layout?: string;
  preview?: Rect;
  dispose?: () => void;
  cancel?: () => void;
}
interface ChoiceControl {
  frame: HTMLElement;
  select?: HTMLSelectElement;
  layout?: string;
}
interface PageLayer {
  page: NativePage;
  layer: HTMLElement;
  controls: Map<string, FieldControl>;
  choices?: Map<string, ChoiceControl>;
  marks?: Map<string, HTMLElement>;
  /** Highlight bands under the printed text, multiplied with the page like a real marker. */
  highlights?: HTMLElement;
  /** Comment badges of highlights (above the page, clickable). */
  badges?: Map<string, HTMLElement>;
  shapes?: ShapeLayer;
  images?: ImageLayer;
  ink: InkLayer;
  cancelPlacement?: () => void;
  placing?: () => boolean;
}
interface EditorState {
  tool: EditorTool;
  textFamily: FontFamily;
  textColor: PdfColor;
  fontSize: number;
  markerWidth: number;
  penWidth: number;
  markerColor: PdfColor;
  penColor: PdfColor;
  selected?: string;
  selectedStroke?: string;
  letterSpacing: number;
  lineSpacing: number;
  textAlignment: 'left' | 'center' | 'right';
  focused?: { input: HTMLInputElement | HTMLTextAreaElement; page: number; name: string };
}

export class TextEditor extends Component {
  private app: App;
  private native: EditorSurface;
  private sessions: VaultSessions;
  private session?: TextSession;
  private toolbar: HTMLElement;
  private tools = new Map<EditorTool, HTMLButtonElement>();
  private status: HTMLElement;
  private message: HTMLElement;
  private saveButton: HTMLButtonElement;
  private removeButton: HTMLButtonElement;
  private undoButton: HTMLButtonElement;
  private editControls: HTMLElement;
  private propertiesButton: HTMLButtonElement;
  private redoButton: HTMLButtonElement;
  private popover?: ToolPopover;
  private textFamily: FontFamily = 'sans';
  private textColor: PdfColor = [0.05, 0.05, 0.05];
  private markerColor: PdfColor = [1, 0.84, 0];
  private penColor: PdfColor = [0.085, 0.085, 0.085];
  private menu?: Menu;
  private layers = new Map<HTMLElement, PageLayer>();
  private tool: EditorTool = 'select';
  private markerWidth = 14;
  private penWidth = 2;
  private smoothPen = true;
  private holdShapes = false;
  private holdHighlighter = true;
  private snapToText = false;
  private loadError = '';
  private loaded = true;
  private fontSize = 14;
  private letterSpacing = 0;
  private lineSpacing = 1.2;
  private textAlignment: 'left' | 'center' | 'right' = 'left';
  private formatPreview?: { name?: string; letterSpacing: number; lineSpacing: number };
  private selected?: string;
  private selectedStroke?: string;
  private focused?: { input: HTMLInputElement | HTMLTextAreaElement; page: number; name: string };
  private timer?: number;
  private unsubscribe?: () => void;
  private focusInteraction?: { input: HTMLElement; release: () => void };
  private composing = new Set<HTMLInputElement | HTMLTextAreaElement>();
  private editing?: string;
  private selection?: ObjectSelection;
  private objectScope?: Scope;
  private objectScopeActive = false;
  private windowFocused = false;
  private openingPopover = false;
  private activeBox?: string;
  private answerLines: AnswerLine[] = [];
  private answerFields = new Set<string>();
  private releaseEditing?: () => void;
  private markColor: PdfColor = MARK_COLORS[0]!.color;
  private lineColor: PdfColor = LINE_COLORS[0]!.color;
  private selectionBar?: { element: HTMLElement; quads: Map<PageLayer, Rect[]> };
  private markPopover?: {
    id: string;
    element: HTMLElement;
    entry: PageLayer;
    textarea: HTMLTextAreaElement;
    created: boolean;
  };
  private markClickPages = new WeakSet<HTMLElement>();
  private listEditing = false;
  private shapeStyle: ShapeStyle = {
    kind: 'rectangle',
    filled: false,
    color: SHAPE_COLORS[0]!.color,
    width: 2,
  };
  private selectedShape?: string;
  private selectedImage?: string;
  private measure?: HTMLTextAreaElement;
  private imageUrls = new Map<string, string>();
  /** Page and PDF point under the pointer, for placing pasted pictures. */
  private hover?: { div: HTMLElement; x: number; y: number };
  private pasteSeen = 0;
  private objectPasteAt = 0;
  private shapeMenu?: HTMLElement;
  private closeShapeMenuListeners?: () => void;
  private listGroup!: HTMLElement;
  private listInput?: { input: HTMLTextAreaElement; name: string };
  private highlightButton!: HTMLButtonElement;
  private highlightCommentButton!: HTMLButtonElement;
  private highlightColors?: HTMLElement;
  private closeColors?: () => void;
  /** Selection captured when a toolbar highlight control is pressed, before focus can move. */
  private pressedSelection?: {
    found: NonNullable<ReturnType<TextEditor['selectionQuads']>>;
    time: number;
  };

  /** Attach document-local editing controls and shortcut ownership to the shared session registry. */
  constructor(app: App, native: EditorSurface, sessions: VaultSessions, state?: EditorState) {
    super();
    this.app = app;
    this.native = native;
    this.sessions = sessions;
    Object.assign(this, sessions.preferences);
    if (state) {
      this.letterSpacing = state.letterSpacing;
      this.lineSpacing = state.lineSpacing;
      this.textAlignment = state.textAlignment;
      this.textFamily = state.textFamily;
      this.textColor = state.textColor;
      this.tool = state.tool;
      this.fontSize = state.fontSize;
      this.markerWidth = state.markerWidth;
      this.penWidth = state.penWidth;
      this.markerColor = state.markerColor;
      this.penColor = state.penColor;
      this.selected = state.selected;
      this.selectedStroke = state.selectedStroke;
      this.focused = state.focused;
    }
    const doc = native.element.ownerDocument;
    this.windowFocused = doc.hasFocus();
    this.registerDomEvent(doc.defaultView!, 'blur', () => {
      this.windowFocused = false;
      this.cancelInteractions();
      this.syncObjectScope();
    });
    this.registerDomEvent(doc.defaultView!, 'focus', () => {
      this.windowFocused = true;
      this.syncObjectScope();
    });
    if (app.keymap) {
      const scope = (this.objectScope = new Scope(app.scope));
      for (const key of ['c', 'v', 'd']) {
        scope.register(['Mod'], key, (event) => {
          if (this.claimScopedShortcut(key, event)) {
            return false;
          }
          return undefined;
        });
      }
      for (const redo of [false, true]) {
        scope.register(redo ? ['Mod', 'Shift'] : ['Mod'], 'z', (event) =>
          this.claimHistoryShortcut(event) ? false : undefined,
        );
      }
      this.register(() => {
        if (this.objectScopeActive) {
          app.keymap.popScope(scope);
        }
      });
    }
    this.register(usePdfFont(doc));
    native.element.classList.add('pdf-form-studio-view');
    this.toolbar = doc.createElement('div');
    this.toolbar.className = 'pdf-form-studio-toolbar';
    this.toolbar.setAttribute('role', 'toolbar');
    this.toolbar.setAttribute('aria-label', 'PDF editor');
    setTooltip(this.toolbar, 'PDF editor', { classes: ['pfs-overlay-tooltip'] });
    const button = (
      parent: HTMLElement,
      label: string,
      icon: string,
      callback: () => void,
      tooltip = true,
    ): HTMLButtonElement => {
      const element = doc.createElement('button');
      element.type = 'button';
      element.className = 'clickable-icon pdf-form-studio-icon';
      setIcon(element, icon);
      setTooltip(element, label, tooltip ? {} : { classes: ['pfs-overlay-tooltip'] });
      this.registerDomEvent(element, 'click', callback);
      parent.append(element);
      return element;
    };
    for (const [tool, label, icon, key] of [
      ['select', 'Select', 'mouse-pointer-2', 'V'],
      ['text', 'Text box', 'type', 'T'],
      ['marker', 'Highlighter', 'highlighter', 'H'],
      ['scribble', 'Pen', 'pencil', 'P'],
      ['eraser', 'Eraser', 'eraser', 'E'],
      ['note', 'Note', 'sticky-note', 'N'],
      ['shape', 'Shape', 'square', 'R'],
    ] as const) {
      this.tools.set(
        tool,
        button(this.toolbar, `${label} (${key})`, icon, () => {
          if (this.tool === tool) {
            this.closePopover();
          } else {
            this.setTool(tool);
          }
        }),
      );
      if (tool === 'text') {
        this.toolbar.append(this.native.answerLineButton());
      }
      if (tool === 'shape') {
        const options = button(this.toolbar, 'Shape options', 'chevron-down', () =>
          this.toggleShapeMenu(options),
        );
        options.classList.add('pfs-shape-options-button');
        this.register(() => this.closeShapeMenu());
        button(this.toolbar, 'Insert image…', 'image-plus', () => this.chooseImageFile());
      }
    }
    // Highlight the PDF text selected on the page, with a colour menu.
    const highlightGroup = doc.createElement('div');
    highlightGroup.className = 'pdf-form-studio-highlight-controls';
    highlightGroup.setAttribute('role', 'group');
    highlightGroup.setAttribute('aria-label', 'Highlight selected text');
    this.toolbar.append(highlightGroup);
    this.highlightButton = button(highlightGroup, 'Highlight selected text', 'baseline', () =>
      this.highlightSelection('toggle'),
    );
    this.highlightButton.classList.add('pfs-highlight-button');
    this.highlightCommentButton = button(
      highlightGroup,
      'Highlight and comment',
      'message-square-plus',
      () => this.highlightSelection('comment'),
    );
    const colorButton = button(highlightGroup, 'Highlight color', 'chevron-down', () =>
      this.toggleHighlightColors(colorButton),
    );
    const underlineButton = button(highlightGroup, 'Underline selected text', 'underline', () =>
      this.lineSelection('underline'),
    );
    const strikeButton = button(
      highlightGroup,
      'Strike through selected text',
      'strikethrough',
      () => this.lineSelection('strikeout'),
    );
    this.register(() => this.closeHighlightColors());
    colorButton.classList.add('pfs-highlight-color-button');
    for (const element of [
      this.highlightButton,
      this.highlightCommentButton,
      colorButton,
      underlineButton,
      strikeButton,
    ]) {
      // Keep the PDF text selection while pressing toolbar buttons.
      element.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        this.capturePressedSelection();
      });
      element.addEventListener('mousedown', (event) => event.preventDefault());
    }
    this.registerDomEvent(doc, 'selectionchange', () =>
      doc.defaultView!.setTimeout(() => this.updateHighlightButton(), 0),
    );
    // Lists and indentation for the selected text box.
    this.listGroup = doc.createElement('div');
    this.listGroup.className = 'pdf-form-studio-list-controls';
    this.listGroup.setAttribute('role', 'group');
    this.listGroup.setAttribute('aria-label', 'Lists and indentation');
    this.toolbar.append(this.listGroup);
    for (const [label, icon, fallback, action] of [
      ['Bulleted list (Ctrl+Shift+8)', 'list', '•', (e: TextEdit) => toggleList(e, 'bullet')],
      [
        'Numbered list (Ctrl+Shift+7)',
        'list-ordered',
        '1.',
        (e: TextEdit) => toggleList(e, 'number'),
      ],
      ['Decrease indent (Shift+Tab)', 'indent-decrease', '⇤', (e: TextEdit) => indent(e, -1)],
      ['Increase indent (Tab)', 'indent-increase', '⇥', (e: TextEdit) => indent(e, 1)],
    ] as const) {
      const element = button(this.listGroup, label, icon, () => this.listAction(action));
      if (!element.querySelector('svg')) {
        element.textContent = fallback;
      }
      // Keep the caret and selection in the text box while clicking.
      element.addEventListener('pointerdown', (event) => event.preventDefault());
      element.addEventListener('mousedown', (event) => event.preventDefault());
    }
    this.editControls = doc.createElement('div');
    this.editControls.className = 'pdf-form-studio-edit-controls';
    this.toolbar.append(this.editControls);
    this.propertiesButton = button(this.editControls, 'Properties', 'sliders-horizontal', () =>
      this.openProperties(),
    );
    this.propertiesButton.classList.add('pfs-properties-button');
    const settingsIcon = this.propertiesButton.createSpan({
      cls: 'pfs-settings-icon',
      attr: { 'aria-hidden': 'true' },
    });
    settingsIcon.append(this.propertiesButton.querySelector('svg')!);
    settingsIcon.createSpan({ cls: 'pfs-settings-color' });
    this.propertiesButton.createSpan({ cls: 'pfs-tool-value' });
    this.saveButton = button(
      this.editControls,
      withKeys('Save', 'Mod+S'),
      'save',
      () => {
        void this.save();
      },
      false,
    );
    this.removeButton = button(
      this.editControls,
      withKeys('Delete selection', 'Delete'),
      'trash-2',
      () => this.removeSelection(),
      false,
    );
    this.undoButton = button(
      this.editControls,
      withKeys('Undo', 'Mod+Z'),
      'undo-2',
      () => this.applyHistory(false),
      false,
    );
    this.redoButton = button(
      this.editControls,
      withKeys('Redo', 'Mod+Shift+Z'),
      'redo-2',
      () => this.applyHistory(true),
      false,
    );
    this.undoButton.setAttribute('aria-keyshortcuts', 'Meta+Z Control+Z');
    this.redoButton.setAttribute('aria-keyshortcuts', 'Meta+Shift+Z Control+Shift+Z');
    this.status = doc.createElement('span');
    this.status.className = 'pdf-form-studio-status';
    this.status.setAttribute('role', 'status');
    this.toolbar.append(this.status);
    const more = button(this.toolbar, 'More options', 'ellipsis', () => this.openMenu(more));
    this.message = doc.createElement('div');
    this.message.className = 'pdf-form-studio-message';
    this.message.setAttribute('role', 'status');
    this.mountToolbar();
    this.register(() => this.menu?.hide());
    // Text highlights: show the highlight bar after a text selection on a PDF page.
    const queueBar = () => doc.defaultView!.setTimeout(() => this.updateSelectionBar(), 0);
    this.registerDomEvent(doc, 'pointerup', queueBar);
    this.registerDomEvent(doc, 'keyup', (event) => {
      if (event.shiftKey || event.key === 'Shift') {
        queueBar();
      }
    });
    this.registerDomEvent(doc, 'selectionchange', () => {
      if (doc.getSelection()?.isCollapsed !== false) {
        this.hideSelectionBar();
      }
    });
    this.registerDomEvent(
      doc,
      'pointerdown',
      (event) => {
        const target = event.target;
        if (
          this.markPopover &&
          !(target instanceof doc.defaultView!.Node && this.markPopover.element.contains(target))
        ) {
          this.closeMarkPopover();
        }
      },
      true,
    );
    this.register(() => {
      this.hideSelectionBar();
      this.markPopover?.element.remove();
      this.markPopover = undefined;
    });
    // Shapes: a click elsewhere deselects; keys delete, nudge or deselect the selected shape.
    this.registerDomEvent(
      doc,
      'pointerdown',
      (event) => {
        const target = event.target;
        const inside = (selector: string) =>
          target instanceof doc.defaultView!.Element &&
          (!!target.closest(selector) || this.toolbar.contains(target));
        if (this.selectedShape && !inside('.pfs-shape-hit, .pfs-shape-handle, .pfs-shape-menu')) {
          this.selectedShape = undefined;
          this.refresh();
        }
        if (this.selectedImage && !inside('.pfs-image')) {
          this.selectedImage = undefined;
          this.refresh();
        }
      },
      true,
    );
    this.registerDomEvent(doc, 'keydown', (event) => this.imageKey(event), true);
    // Pictures from the system clipboard (screenshots, copied images).
    this.registerDomEvent(doc, 'paste', (event) => this.pasteEvent(event), true);
    this.registerDomEvent(
      doc,
      'keydown',
      (event) => {
        const id = this.selectedShape;
        const target = event.target;
        const mod = event.metaKey || event.ctrlKey;
        const clip = event.key.toLowerCase();
        if (
          id &&
          this.session &&
          mod &&
          !event.altKey &&
          !event.shiftKey &&
          ['c', 'x', 'v', 'd'].includes(clip) &&
          (clip !== 'v' || !!copiedShape || !!copiedObjects) &&
          !(
            target instanceof doc.defaultView!.Element &&
            target.closest('input, textarea, select, [contenteditable="true"]')
          )
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (event.repeat && clip !== 'v') {
            return;
          }
          try {
            if (clip === 'c') {
              this.copyShape(id);
            } else if (clip === 'x') {
              this.cutShape(id);
            } else if (clip === 'd') {
              this.duplicateShape(id);
            } else {
              this.objectPasteAt = Date.now();
              const shape = this.session.snapshot.shapes?.find((item) => item.id === id);
              this.pasteCopied(shape?.page ?? 1);
            }
            this.scheduleSave();
          } catch (error) {
            this.showError(error);
          }
          this.refresh();
          return;
        }
        if (
          !id ||
          !this.session ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          (target instanceof doc.defaultView!.Element &&
            target.closest('input, textarea, select, [contenteditable="true"]'))
        ) {
          return;
        }
        const shape = this.session.snapshot.shapes?.find((item) => item.id === id);
        if (!shape) {
          return;
        }
        const step = event.shiftKey ? 10 : 1;
        const delta: Record<string, [number, number]> = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, step],
          ArrowDown: [0, -step],
        };
        try {
          if (event.key === 'Delete' || event.key === 'Backspace') {
            this.session.deleteShape(id);
            this.selectedShape = undefined;
          } else if (event.key === 'Escape') {
            this.selectedShape = undefined;
            this.refresh();
          } else if (delta[event.key]) {
            const [dx, dy] = delta[event.key]!;
            const bounds = this.session.snapshot.pages[shape.page - 1]!;
            const extent: Rect = shape.box
              ? shapeRect(shape)
              : [
                  Math.min(shape.start![0], shape.end![0]),
                  Math.min(shape.start![1], shape.end![1]),
                  Math.max(shape.start![0], shape.end![0]),
                  Math.max(shape.start![1], shape.end![1]),
                ];
            const x = Math.max(bounds[0] - extent[0], Math.min(bounds[2] - extent[2], dx));
            const y = Math.max(bounds[1] - extent[1], Math.min(bounds[3] - extent[3], dy));
            this.session.updateShape(
              id,
              shape.box
                ? { box: [shape.box[0] + x, shape.box[1] + y, shape.box[2] + x, shape.box[3] + y] }
                : {
                    start: [shape.start![0] + x, shape.start![1] + y],
                    end: [shape.end![0] + x, shape.end![1] + y],
                  },
            );
          } else {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          this.scheduleSave();
        } catch (error) {
          this.showError(error);
        }
      },
      true,
    );
    this.registerDomEvent(
      doc,
      'pointerdown',
      (event) => {
        if (this.focused && event.target !== this.focused.input) {
          this.focused = undefined;
        }
        const target = event.target;
        if (!(target instanceof doc.defaultView!.Element)) {
          return;
        }
        const inPdf = this.native.element.contains(target);
        const ownControl = this.ownsControl(target);
        if (
          !ownControl &&
          (!inPdf ||
            target.closest('.pdf-form-studio-box')?.querySelector<HTMLElement>('[data-pdf-field]')
              ?.dataset.pdfField !== this.activeBox)
        ) {
          this.endTextEditing();
        }
        if (
          !ownControl &&
          (!inPdf ||
            !target.closest(`.pdf-form-studio-box, .pdf-form-studio-ink-control, ${MARK_UI}`))
        ) {
          this.selected = undefined;
          this.selectedStroke = undefined;
          this.updateStatus();
          this.refresh();
          const active = doc.activeElement;
          if (
            active instanceof doc.defaultView!.HTMLElement &&
            [...this.layers.values()].some((entry) => entry.layer.contains(active))
          ) {
            active.blur();
          }
        }
      },
      true,
    );
    this.registerDomEvent(doc, 'focusin', (event) => {
      // Keyboard-opened dialogs also move focus deliberately. Never restore
      // a PDF input over the quick switcher, command palette or another note.
      if (this.focused && event.target !== this.focused.input) {
        this.focused = undefined;
      }
      if (
        event.target instanceof doc.defaultView!.Element &&
        !this.native.element.contains(event.target) &&
        !this.ownsControl(event.target)
      ) {
        this.closePopover();
        this.endTextEditing();
        this.selected = undefined;
        this.selectedStroke = undefined;
        this.updateStatus();
        this.refresh();
      }
      if (
        event.target instanceof doc.defaultView!.HTMLElement &&
        this.toolbar.contains(event.target) &&
        this.session
      ) {
        this.releaseFocus();
        this.focusInteraction = { input: event.target, release: this.session.beginInteraction() };
      }
      this.syncObjectScope();
    });
    this.registerDomEvent(doc, 'focusout', () => this.syncObjectScope());
    this.registerDomEvent(this.toolbar, 'focusout', (event) => {
      if (this.focusInteraction?.input === event.target) {
        this.releaseFocus();
      }
      if (this.loaded && this.session?.dirty) {
        this.scheduleSave();
      }
    });
    // Live Preview handles shortcuts before an embedded input's bubble phase.
    // Claim Save at the window capture phase, scoped to this editor's controls.
    this.registerDomEvent(
      doc.defaultView!,
      'keydown',
      (event) => {
        const target = event.target;
        if (this.claimHistoryShortcut(event)) {
          return;
        }
        if (event.key === 'Escape' && this.popover?.cancelScrub()) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        const objectKey =
          (event.metaKey || event.ctrlKey) && ['c', 'v', 'd'].includes(event.key.toLowerCase());
        if (
          !this.shortcutTarget(target) &&
          !(objectKey && this.objectShortcutActive()) &&
          !(target === doc.body && event.key === 'Escape' && this.tool !== 'select')
        ) {
          return;
        }
        if (
          event.key === 'Tab' &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          target instanceof doc.defaultView!.HTMLElement &&
          target.dataset.pdfField &&
          !event.isComposing &&
          this.navigateAnswerLine(target.dataset.pdfField, event.shiftKey ? -1 : 1)
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        if (event.key === 'Escape') {
          this.selection?.cancel();
          this.selection?.clear();
          for (const entry of this.layers.values()) {
            entry.ink.cancel();
            entry.cancelPlacement?.();
            for (const control of entry.controls.values()) {
              control.cancel?.();
            }
          }
          this.endTextEditing();
          this.selected = undefined;
          this.selectedStroke = undefined;
          if (target instanceof doc.defaultView!.HTMLElement) {
            target.blur();
          }
          this.updateStatus();
          this.refresh();
          return;
        }
        if (!(event.metaKey || event.ctrlKey)) {
          if (!this.isTextTarget(target) && !event.altKey) {
            const shortcut: Record<string, EditorTool> = {
              v: 'select',
              t: 'text',
              p: 'scribble',
              h: 'marker',
              e: 'eraser',
              n: 'note',
              r: 'shape',
            };
            const tool = shortcut[event.key.toLowerCase()];
            if (tool) {
              event.preventDefault();
              event.stopPropagation();
              this.setTool(tool);
            }
          }
          return;
        }
        if (event.key.toLowerCase() === 'd' && !event.shiftKey) {
          const objects = this.shortcutObjects(target);
          if (objects.length && this.session) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (event.repeat) {
              return;
            }
            try {
              this.selectCreated(this.session.pasteObjects(this.session.copyObjects(objects)));
              this.scheduleSave();
            } catch (error) {
              this.showError(error);
            }
            return;
          }
        }
        if (
          (event.key.toLowerCase() === 'c' || event.key.toLowerCase() === 'v') &&
          !event.shiftKey &&
          !event.altKey &&
          this.shortcutObjects(target).length &&
          (!doc.getSelection()?.toString() ||
            (target instanceof doc.defaultView!.HTMLElement &&
              target.classList.contains('pdf-form-studio-shortcut-proxy')))
        ) {
          this.claimScopedShortcut(event.key.toLowerCase(), event);
          return;
        }
        if (event.key.toLowerCase() === 's') {
          event.preventDefault();
          event.stopImmediatePropagation();
          void this.save();
        }
      },
      true,
    );
    this.registerDomEvent(
      doc.defaultView!,
      'copy',
      (event) => {
        const target = event.target;
        if (
          !(target instanceof doc.defaultView!.Element) ||
          !target.closest('.pdf-form-studio-view')
        ) {
          copiedObjects = undefined;
          return;
        }
        if (!this.shortcutTarget(target)) {
          return;
        }
        if (doc.getSelection()?.toString()) {
          copiedObjects = undefined;
          return;
        }
        const objects = this.shortcutObjects(target);
        if (!objects.length || !this.session || !event.clipboardData) {
          copiedObjects = undefined;
          return;
        }
        try {
          const token = globalThis.crypto.randomUUID();
          const data = this.session.copyObjects(objects);
          const text =
            data
              .filter((item) => item.kind === 'text')
              .map((item) => item.value)
              .join('\n') || 'PDF Editor elements';
          event.clipboardData.setData(objectClipboardType, token);
          event.clipboardData.setData('text/plain', text);
          event.clipboardData.setData('text/html', objectClipboardHtml(doc, text, token));
          copiedObjects = { token, objects: data, text, custom: true };
          event.preventDefault();
          event.stopImmediatePropagation();
        } catch (error) {
          this.showError(error);
        }
      },
      true,
    );
    this.registerDomEvent(
      doc.defaultView!,
      'cut',
      () => {
        copiedObjects = undefined;
      },
      true,
    );
    // Switching windows does not replace the clipboard. Retain the copy so a
    // matching clipboard token can authorize an object paste after returning.
    this.registerDomEvent(doc.defaultView!, 'blur', () => {
      if (copiedObjects) {
        copiedObjects.blurred = true;
      }
      if (!this.selected && !this.selectedStroke && !this.selection?.objects.length) {
        return;
      }
      this.selected = undefined;
      this.selectedStroke = undefined;
      this.selection?.clear();
      this.updateStatus();
      this.refresh();
    });
    this.registerDomEvent(
      doc.defaultView!,
      'paste',
      (event) => {
        if (
          !this.shortcutTarget(event.target) ||
          (this.isTextTarget(event.target) && !this.shortcutField(event.target)) ||
          !this.session ||
          !event.clipboardData
        ) {
          return;
        }
        const target = event.target;
        const objects = this.shortcutObjects(target);
        const copy = copiedObjects;
        const session = this.session;
        const focused = doc.activeElement;
        if (!objects.length) {
          return;
        }
        const text = event.clipboardData.getData('text/plain');
        const nativeToken =
          event.clipboardData.getData(objectClipboardType) ||
          event.clipboardData.getData(webObjectClipboardType);
        const pasteCopy = () => {
          if (
            !copy ||
            copiedObjects !== copy ||
            !this.loaded ||
            this.session !== session ||
            !this.sameShortcutSelection(target, objects, focused)
          ) {
            return;
          }
          try {
            this.selectCreated(session.pasteObjects(copy.objects));
            this.scheduleSave();
          } catch (error) {
            this.showError(error);
          }
        };
        if (copy && nativeToken === copy.token) {
          event.preventDefault();
          event.stopImmediatePropagation();
          pasteCopy();
          return;
        }
        const pasteText = () => {
          if (
            !this.loaded ||
            this.session !== session ||
            !this.sameShortcutSelection(target, objects, focused)
          ) {
            return;
          }
          if (this.isTextTarget(target)) {
            return;
          }
          this.pastePlainTextBox(text, objects);
        };
        const clipboard = doc.defaultView!.navigator.clipboard;
        if ((copy?.custom || copy?.write) && typeof clipboard?.read === 'function') {
          // Menu and context-menu paste can deliver only a filtered DataTransfer.
          // The async clipboard still carries our web custom format.
          event.preventDefault();
          event.stopImmediatePropagation();
          const answer =
            target instanceof doc.defaultView!.HTMLInputElement ||
            target instanceof doc.defaultView!.HTMLTextAreaElement
              ? this.shortcutField(target)
                ? target
                : undefined
              : undefined;
          const caret =
            answer && answer.selectionStart !== null && answer.selectionEnd !== null
              ? { value: answer.value, start: answer.selectionStart, end: answer.selectionEnd }
              : undefined;
          void (async () => {
            if (copy.write) {
              await copy.write;
            }
            if (copy.custom) {
              try {
                if (await this.clipboardHasObjectToken(clipboard, copy.token)) {
                  pasteCopy();
                  return;
                }
              } catch {
                /* An unreadable token cannot authorize an object paste. */
              }
            }
            if (copiedObjects !== copy) {
              return;
            }
            if (copiedObjects === copy) {
              copiedObjects = undefined;
            }
            if (
              answer &&
              caret &&
              answer.isConnected &&
              answer.ownerDocument.activeElement === answer &&
              this.sameShortcutSelection(target, objects, focused) &&
              answer.value === caret.value &&
              answer.selectionStart === caret.start &&
              answer.selectionEnd === caret.end
            ) {
              answer.setRangeText(text, caret.start, caret.end, 'end');
              answer.dispatchEvent(new doc.defaultView!.Event('input', { bubbles: true }));
            } else {
              pasteText();
            }
          })();
          return;
        }
        copiedObjects = undefined;
        if (!this.isTextTarget(target) && text) {
          event.preventDefault();
          event.stopImmediatePropagation();
          pasteText();
        }
      },
      true,
    );
    this.updateStatus();
    void this.openSession()
      .then(() => {
        this.updateStatus();
        this.refresh();
      })
      .catch((error) => {
        if (!this.loaded) {
          return;
        }
        this.loadError = error instanceof Error ? error.message : String(error);
        this.updateStatus();
      });
  }

  get file() {
    return this.native.file;
  }
  captureState(native?: NativePdf): EditorState | undefined {
    return !native || this.native.file === native.file
      ? {
          tool: this.tool,
          letterSpacing: this.letterSpacing,
          lineSpacing: this.lineSpacing,
          textAlignment: this.textAlignment,
          textFamily: this.textFamily,
          textColor: this.textColor,
          fontSize: this.fontSize,
          markerWidth: this.markerWidth,
          penWidth: this.penWidth,
          markerColor: this.markerColor,
          penColor: this.penColor,
          selected: this.selected,
          selectedStroke: this.selectedStroke,
          focused: this.focused,
        }
      : undefined;
  }
  private async openSession(): Promise<void> {
    if (this.session) {
      return;
    }
    this.status.textContent = 'Loading…';
    const session = await this.sessions.get(this.native.file);
    if (!this.loaded || this.session) {
      return;
    }
    this.session = session;
    this.selection = this.addChild(
      new ObjectSelection(
        session,
        this.native.element,
        {
          enabled: () => this.tool === 'select',
          changed: () => {
            this.updateStatus();
            this.refresh();
          },
          save: () => this.scheduleSave(),
          error: (error) => this.showError(error),
          floatingToolbar: () => this.floatingToolbarHost(),
          shortcut: (key, event) => this.claimScopedShortcut(key, event),
          endTyping: () => {
            this.selected = undefined;
            this.selectedStroke = undefined;
            this.selectedShape = undefined;
            this.selectedImage = undefined;
            this.focused = undefined;
            this.endTextEditing();
          },
        },
        this.app,
      ),
    );
    this.unsubscribe = session.subscribe(() => {
      if (session.replacing || session.status === 'conflict') {
        this.closePopover();
      }
      this.updateStatus();
      this.refresh();
    });
  }

  private activateBox(name: string): void {
    if (this.activeBox === name) {
      return;
    }
    this.endTextEditing();
    this.activeBox = name;
    this.releaseEditing = this.session!.beginTextEdit(name);
  }

  private endTextEditing(retain?: string): void {
    const wasEditing = this.editing;
    this.editing = undefined;
    const name = this.activeBox;
    if (name !== retain) {
      this.activeBox = undefined;
      this.releaseEditing?.();
      this.releaseEditing = undefined;
      if (name && this.session?.pruneEmptyBoxes(name)) {
        this.scheduleSave();
      }
    }
    if (wasEditing || name) {
      this.refresh();
    }
  }

  private setTool(tool: EditorTool): void {
    if (!this.session || this.session.status === 'conflict' || this.session.replacing) {
      return;
    }
    this.closePopover();
    this.selection?.cancel();
    this.selection?.clear();
    const retain = tool === 'select' || tool === 'text' ? this.activeBox : undefined;
    this.endTextEditing(retain);
    for (const entry of this.layers.values()) {
      entry.cancelPlacement?.();
      entry.ink.cancel();
      for (const control of entry.controls.values()) {
        control.cancel?.();
      }
    }
    this.releaseFocus();
    this.focused = undefined;
    const active = this.native.element.ownerDocument.activeElement;
    if (
      active instanceof this.native.element.ownerDocument.defaultView!.HTMLElement &&
      [...this.layers.values()].some((entry) => entry.layer.contains(active))
    ) {
      active.blur();
    }
    this.tool = tool;
    if (tool !== 'select') {
      this.selectedShape = undefined;
    }
    this.hideSelectionBar();
    this.closeMarkPopover();
    this.selected = retain;
    this.selectedStroke = undefined;
    this.updateStatus();
    this.refresh();
    if (retain) {
      for (const entry of this.layers.values()) {
        entry.controls.get(`${retain}:0`)?.frame.focus({ preventScroll: true });
      }
    }
    if (this.session.dirty) {
      this.scheduleSave();
    }
  }

  /** Detected lines stay transient; clicking or tabbing to one creates a field. */
  setAnswerLines(lines: AnswerLine[]): void {
    this.answerLines = lines
      .map((line) => ({ page: line.page, rect: [...line.rect] as Rect }))
      .sort((a, b) => a.page - b.page || b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0]);
    for (const field of this.session?.snapshot.fields ?? []) {
      if (this.answerLines.some((line) => this.answerWidget(field, line) >= 0)) {
        this.answerFields.add(field.name);
      }
    }
    this.refresh();
  }
  private answerWidget(field: TextField, line: AnswerLine): number {
    return field.widgets.findIndex(
      (widget) =>
        widget.page === line.page &&
        line.rect[0] < widget.rect[2] &&
        line.rect[2] > widget.rect[0] &&
        line.rect[1] < widget.rect[3] &&
        line.rect[3] > widget.rect[1],
    );
  }
  private navigateAnswerLine(name: string, direction: number): boolean {
    if (!this.session || this.session.replacing || this.session.status === 'conflict') {
      return false;
    }
    const field = this.session.snapshot.fields.find((field) => field.name === name);
    if (!field || (!this.answerFields.has(name) && !field.ruled)) {
      return false;
    }
    const index = this.answerLines.findIndex((line) => this.answerWidget(field, line) >= 0);
    if (index < 0) {
      return false;
    }
    for (
      let next = index + direction;
      next >= 0 && next < this.answerLines.length;
      next += direction
    ) {
      const line = this.answerLines[next]!;
      const existing = this.session.snapshot.fields.find(
        (field) => this.answerWidget(field, line) >= 0,
      );
      if (existing?.readOnly || existing?.name === name) {
        continue;
      }
      this.addSuggestedField(line.page, line.rect, true);
      return true;
    }
    return false;
  }
  private adoptAdjacentAnswer(line: AnswerLine): TextField | undefined {
    if (!this.session || !this.sessions.preferences.flowAnswerLines) {
      return;
    }
    for (const anchor of this.session.snapshot.fields) {
      if (!anchor.owned || anchor.readOnly || anchor.widgets.length !== 1) {
        continue;
      }
      const widget = anchor.widgets[0]!;
      if (widget.page !== line.page || widget.rotation !== 0) {
        continue;
      }
      const rows = anchor.ruled?.rows ?? 1;
      if (rows > 500) {
        continue;
      }
      const height = widget.rect[3] - widget.rect[1] - (rows - 1) * (anchor.ruled?.spacing ?? 0);
      if (!anchor.ruled && (widget.rect[2] - widget.rect[0] < 100 || height > 35)) {
        continue;
      }
      const anchors: AnswerLine[] = Array.from({ length: rows }, (_, i) => ({
        page: line.page,
        rect: [
          widget.rect[0],
          widget.rect[3] - height - i * (anchor.ruled?.spacing ?? 0),
          widget.rect[2],
          widget.rect[3] - i * (anchor.ruled?.spacing ?? 0),
        ],
      }));
      const candidates = [
        ...this.answerLines.filter(
          (candidate) => candidate.page === line.page && this.answerWidget(anchor, candidate) < 0,
        ),
        ...anchors,
      ];
      const block = ruledAnswerBlock(candidates, line, (candidate) =>
        this.session!.snapshot.fields.some(
          (field) => field !== anchor && this.answerWidget(field, candidate) >= 0,
        ),
      );
      if (!block || block.layout.rows <= rows || Math.abs(block.rect[3] - widget.rect[3]) > 3) {
        continue;
      }
      const rect: Rect = [widget.rect[0], block.rect[1], widget.rect[2], widget.rect[3]];
      if (this.session.adoptRuledBlock(anchor.name, rect, block.layout)) {
        return anchor;
      }
    }
    return;
  }
  private isTextTarget(target: EventTarget | null): boolean {
    const element =
      target instanceof this.native.element.ownerDocument.defaultView!.Element ? target : undefined;
    return (
      !!element &&
      !element.classList.contains('pdf-form-studio-shortcut-proxy') &&
      !!element.closest('input, textarea, [contenteditable="true"]')
    );
  }
  /** A caret in an owned PDF answer selects the box; highlighted text keeps native clipboard behavior. */
  private shortcutField(target: EventTarget | null): string | undefined {
    const view = this.native.element.ownerDocument.defaultView!;
    if (
      !(target instanceof view.HTMLInputElement || target instanceof view.HTMLTextAreaElement) ||
      target.selectionStart !== target.selectionEnd
    ) {
      return;
    }
    const name = target.dataset.pdfField;
    return name &&
      this.session?.snapshot.fields.some(
        (field) =>
          field.name === name && field.owned && !field.readOnly && field.widgets.length === 1,
      )
      ? name
      : undefined;
  }
  private shortcutObjects(target: EventTarget | null): PdfObject[] {
    // Obsidian shares keymap scopes across pop-out windows. Never let a
    // selected PDF consume a shortcut dispatched by another document.
    if (!(target instanceof this.native.element.ownerDocument.defaultView!.Node)) {
      return [];
    }
    const field = this.shortcutField(target);
    if (field) {
      return [{ kind: 'text', id: field }];
    }
    if (
      target.instanceOf(this.native.element.ownerDocument.defaultView!.HTMLElement) &&
      target.classList.contains('pdf-form-studio-shortcut-proxy')
    ) {
      return this.selectedObjects();
    }
    if (this.isTextTarget(target)) {
      // Settings inputs keep native keyboard editing/copy, even while their PDF object scope is active.
      if (
        target instanceof this.native.element.ownerDocument.defaultView!.Element &&
        this.ownsControl(target)
      ) {
        return [];
      }
      // Live Preview can keep its note editor as the keyboard target even
      // while the PDF selection owns the active Obsidian shortcut scope.
      return !this.native.element.contains(target) && this.objectShortcutActive()
        ? this.selectedObjects()
        : [];
    }
    return this.selectedObjects();
  }
  private objectShortcutActive(): boolean {
    return this.objectScopeActive || !!this.selection?.objects.length;
  }
  /** Apply shared document history for both toolbar and shortcuts, retaining focus after object removal. */
  private applyHistory(redo: boolean): void {
    const doc = this.native.element.ownerDocument;
    const active = doc.activeElement;
    const layer =
      active instanceof doc.defaultView!.Element && this.native.element.contains(active)
        ? active.closest<HTMLElement>('.pdf-form-studio-layer')
        : undefined;
    try {
      if (redo) {
        this.session?.redoStroke();
      } else {
        this.session?.undoStroke();
      }
      this.selectedStroke = undefined;
      this.updateStatus();
      this.refresh();
      this.scheduleSave();
      // Removing a focused object must keep the next Undo/Redo in this PDF, not the containing note.
      if (layer?.isConnected && (doc.activeElement === doc.body || !doc.activeElement)) {
        layer.focus({ preventScroll: true });
      }
    } catch (error) {
      this.showError(error);
    }
  }
  /** Claim history keys only for this editor, preserving native typing undo and consuming exhausted object history. */
  private claimHistoryShortcut(event: KeyboardEvent): boolean {
    const target = event.target;
    const view = this.native.element.ownerDocument.defaultView!;
    const ownControl = target instanceof view.Element && this.ownsControl(target);
    if (
      !this.loaded ||
      !this.session ||
      !(event.metaKey || event.ctrlKey) ||
      event.altKey ||
      event.isComposing ||
      event.key.toLowerCase() !== 'z' ||
      !(target instanceof view.Node) ||
      (!this.shortcutTarget(target) && !ownControl && !this.objectShortcutActive())
    ) {
      return false;
    }
    if (this.isTextTarget(target) && (this.shortcutTarget(target) || ownControl)) {
      // Preserve the browser's text-edit history, while keeping the note's keymap out.
      event.stopImmediatePropagation();
      return false;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    // Consume exhausted/blocked object history too: it must never undo the enclosing note.
    if (
      !event.repeat &&
      (event.shiftKey ? this.session.canRedoStroke : this.session.canUndoStroke)
    ) {
      this.applyHistory(event.shiftKey);
    }
    return true;
  }
  private claimScopedShortcut(key: string, event: KeyboardEvent): boolean {
    if (key === 'z') {
      return this.claimHistoryShortcut(event);
    }
    const objects = this.shortcutObjects(event.target);
    if (
      !this.loaded ||
      !this.session ||
      !objects.length ||
      event.shiftKey ||
      event.altKey ||
      event.isComposing
    ) {
      return false;
    }
    const target = event.target;
    const inPdf =
      target instanceof this.native.element.ownerDocument.defaultView!.Node &&
      this.native.element.contains(target);
    if (inPdf && this.isTextTarget(target) && !this.shortcutField(target)) {
      return false;
    }
    if (key === 'd') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) {
        try {
          this.selectCreated(this.session.pasteObjects(this.session.copyObjects(objects)));
          this.scheduleSave();
        } catch (error) {
          this.showError(error);
        }
      }
      return true;
    }
    if (key === 'v' && !copiedObjects) {
      return false;
    }
    if (key === 'v') {
      this.objectPasteAt = Date.now();
    }
    const view = this.native.element.ownerDocument.defaultView!;
    const answer =
      key === 'v' &&
      (target instanceof view.HTMLInputElement || target instanceof view.HTMLTextAreaElement) &&
      this.shortcutField(target)
        ? target
        : undefined;
    const caret =
      answer && answer.selectionStart !== null && answer.selectionEnd !== null
        ? { value: answer.value, start: answer.selectionStart, end: answer.selectionEnd }
        : undefined;
    // Obsidian's Live Preview keymap consumes these keys before the browser
    // dispatches copy/paste events for an embedded PDF. Use the system
    // clipboard directly while this PDF owns the active shortcut scope.
    event.preventDefault();
    event.stopImmediatePropagation();
    const clipboard = this.native.element.ownerDocument.defaultView?.navigator.clipboard;
    if (key === 'c') {
      try {
        const data = this.session.copyObjects(objects);
        const text =
          data
            .filter((item) => item.kind === 'text')
            .map((item) => item.value)
            .join('\n') || 'PDF Editor elements';
        const copy: ObjectCopy = {
          token: globalThis.crypto.randomUUID(),
          objects: data,
          text,
          custom: false,
        };
        copiedObjects = copy;
        // A web custom format carries an opaque identity without changing the
        // plain text seen when this answer is pasted into another application.
        const writePlainText = async () => {
          try {
            await clipboard?.writeText?.(text);
          } catch {
            /* Internal copy still works in restricted contexts. */
          }
        };
        if (clipboard?.write && typeof view.ClipboardItem === 'function') {
          try {
            const item = new view.ClipboardItem({
              'text/plain': new Blob([text], { type: 'text/plain' }),
              'text/html': new Blob(
                [objectClipboardHtml(this.native.element.ownerDocument, text, copy.token)],
                { type: 'text/html' },
              ),
              [webObjectClipboardType]: new Blob([copy.token], { type: objectClipboardType }),
            });
            copy.write = clipboard.write([item]).then(() => {
              copy.custom = true;
            }, writePlainText);
          } catch {
            copy.write = writePlainText();
          }
        } else {
          copy.write = writePlainText();
        }
      } catch (error) {
        this.showError(error);
      }
      return true;
    }
    const copy = copiedObjects;
    const session = this.session;
    if (!copy) {
      return false;
    }
    const focused = this.native.element.ownerDocument.activeElement;
    const paste = () => {
      if (
        copiedObjects !== copy ||
        !this.loaded ||
        this.session !== session ||
        !this.sameShortcutSelection(target, objects, focused)
      ) {
        return;
      }
      try {
        this.selectCreated(session.pasteObjects(copy.objects));
        this.scheduleSave();
      } catch (error) {
        this.showError(error);
      }
    };
    const pasteCurrentText = (value: string) => {
      if (
        !answer ||
        !caret ||
        !this.loaded ||
        this.session !== session ||
        !answer.isConnected ||
        answer.readOnly ||
        !this.sameShortcutSelection(target, objects, focused) ||
        answer.ownerDocument.activeElement !== answer ||
        answer.value !== caret.value ||
        answer.selectionStart !== caret.start ||
        answer.selectionEnd !== caret.end
      ) {
        return;
      }
      answer.setRangeText(value, caret.start, caret.end, 'end');
      answer.dispatchEvent(new view.Event('input', { bubbles: true }));
    };
    const pasteExternalText = (value: string) => {
      if (answer) {
        pasteCurrentText(value);
        return;
      }
      if (
        this.loaded &&
        this.session === session &&
        this.sameShortcutSelection(target, objects, focused)
      ) {
        this.pastePlainTextBox(value, objects);
      }
    };
    if (!clipboard?.readText && !clipboard?.read) {
      if (!copy.blurred) {
        paste();
      }
      return true;
    }
    void (async () => {
      // Clipboard writes and reads can be unavailable in some Obsidian
      // contexts. The window-blur guard still invalidates their fallback.
      if (copy.write) {
        await copy.write;
      }
      if (copiedObjects !== copy) {
        return;
      }
      if (copy.custom && typeof clipboard.read === 'function') {
        try {
          const matches = await this.clipboardHasObjectToken(clipboard, copy.token);
          if (copiedObjects !== copy) {
            return;
          }
          if (matches) {
            paste();
            return;
          }
        } catch {
          /* Without a readable token, do not paste a cached PDF object. */
        }
        copiedObjects = undefined;
        try {
          if (clipboard.readText) {
            pasteExternalText(await clipboard.readText());
          }
        } catch {
          /* No readable text to insert. */
        }
        return;
      }
      if (copy.blurred) {
        copiedObjects = undefined;
        try {
          if (clipboard.readText) {
            pasteExternalText(await clipboard.readText());
          }
        } catch {
          /* No readable text to insert. */
        }
        return;
      }
      if (!clipboard.readText) {
        paste();
        return;
      }
      try {
        const current = await clipboard.readText();
        if (copiedObjects !== copy) {
          return;
        }
        if (current !== copy.text) {
          copiedObjects = undefined;
          pasteExternalText(current);
          return;
        }
      } catch {
        /* A same-window copy remains usable when read permission is denied. */
      }
      paste();
    })();
    return true;
  }
  private syncObjectScope(): void {
    if (!this.objectScope) {
      return;
    }
    const focused = this.native.element.ownerDocument.activeElement;
    // Obsidian's window capture handler runs before ours. Own its public keymap
    // scope for the focused PDF canvas too, even when no object is selected.
    const focusedPdf = !!focused && (this.shortcutTarget(focused) || this.ownsControl(focused));
    const active =
      this.windowFocused &&
      !!this.session &&
      !this.selection?.objects.length &&
      (!!(this.selected || this.selectedStroke) || focusedPdf);
    if (active === this.objectScopeActive) {
      return;
    }
    this.objectScopeActive = active;
    if (active) {
      this.app.keymap.pushScope(this.objectScope);
    } else {
      this.app.keymap.popScope(this.objectScope);
    }
  }
  private floatingToolbarHost(): HTMLElement | undefined {
    const host = this.native.toolbarHost().parentElement;
    return host?.classList.contains('pfs-floating-toolbar') ? host : undefined;
  }
  private ownsControl(target: Element): boolean {
    return (
      this.toolbar.contains(target) ||
      !!this.popover?.element.contains(target) ||
      !!this.highlightColors?.contains(target) ||
      !!this.shapeMenu?.contains(target) ||
      (this.openingPopover && !!target.closest('.pfs-tool-popover'))
    );
  }
  private shortcutTarget(target: EventTarget | null): boolean {
    const doc = this.native.element.ownerDocument;
    return (
      target instanceof doc.defaultView!.Node &&
      (this.native.element.contains(target) ||
        !!this.floatingToolbarHost()?.contains(target) ||
        (target === doc.body && !!this.selection?.active))
    );
  }
  private selectedObjects(): PdfObject[] {
    if (this.selection?.objects.length) {
      return [...this.selection.objects];
    }
    if (
      this.selected &&
      this.session?.snapshot.fields.some(
        (field) => field.name === this.selected && field.owned && !field.readOnly,
      )
    ) {
      return [{ kind: 'text', id: this.selected }];
    }
    if (
      this.selectedStroke &&
      this.session?.snapshot.strokes.some(
        (stroke) => stroke.id === this.selectedStroke && !stroke.readOnly,
      )
    ) {
      return [{ kind: 'ink', id: this.selectedStroke }];
    }
    return [];
  }
  private sameShortcutSelection(
    target: EventTarget | null,
    objects: PdfObject[],
    focused: Element | null,
  ): boolean {
    const view = this.native.element.ownerDocument.defaultView!;
    if (
      !(target instanceof view.Node) ||
      !target.isConnected ||
      this.native.element.ownerDocument.activeElement !== focused
    ) {
      return false;
    }
    const current = this.shortcutObjects(target);
    return (
      current.length === objects.length &&
      current.every(
        (object, index) => object.kind === objects[index]!.kind && object.id === objects[index]!.id,
      )
    );
  }
  private async clipboardHasObjectToken(clipboard: Clipboard, token: string): Promise<boolean> {
    const view = this.native.element.ownerDocument.defaultView!;
    for (const item of await clipboard.read()) {
      if (
        item.types.includes(webObjectClipboardType) &&
        (await (await item.getType(webObjectClipboardType)).text()) === token
      ) {
        return true;
      }
      if (item.types.includes('text/html')) {
        const html = await (await item.getType('text/html')).text();
        if (
          new view.DOMParser()
            .parseFromString(html, 'text/html')
            .querySelector('[data-pdf-editor-objects]')
            ?.getAttribute('data-pdf-editor-objects') === token
        ) {
          return true;
        }
      }
    }
    return false;
  }
  private pastePlainTextBox(value: string, objects: PdfObject[]): void {
    if (!value.trim() || !this.session || !objects.length || !this.session.canEditObjects) {
      return;
    }
    try {
      const anchor = this.session.copyObjects(objects)[0];
      if (!anchor) {
        return;
      }
      const bounds = this.session.snapshot.pages[anchor.page - 1]!;
      const width = Math.min(300, bounds[2] - bounds[0]);
      const charactersPerRow = Math.max(1, Math.floor((width - 8) / (this.fontSize * 0.6)));
      const rows = value
        .split(/\r\n?|\n/)
        .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charactersPerRow)), 0);
      const height = Math.min(
        bounds[3] - bounds[1],
        Math.max(this.fontSize * 1.4 + 8, rows * this.fontSize * 1.4 + 8),
      );
      const x = Math.max(bounds[0], Math.min(bounds[2] - width, anchor.rect[0]));
      let top = anchor.rect[1] - 12;
      if (top - height < bounds[1]) {
        top = anchor.rect[3] + 12 + height;
      }
      top = Math.max(bounds[1] + height, Math.min(bounds[3], top));
      const rect: Rect = [x, top - height, x + width, top];
      const rotation =
        this.native.pages().find((page) => page.number === anchor.page)?.viewport.rotation ?? 0;
      const text: CopiedPdfObject = {
        kind: 'text',
        page: anchor.page,
        rect,
        rotation,
        value,
        fontSize: this.fontSize,
        fontFamily: this.textFamily,
        color: [...this.textColor],
        letterSpacing: this.letterSpacing,
        lineSpacing: this.lineSpacing,
        alignment: this.textAlignment,
        multiline: true,
      };
      this.selectCreated(this.session.pasteObjects([text], [0, 0]));
      this.scheduleSave();
    } catch (error) {
      this.showError(error);
    }
  }
  private clearBrowserSelection(): void {
    this.native.element.ownerDocument.getSelection()?.removeAllRanges();
  }
  private selectCreated(objects: PdfObject[]): void {
    if (!objects.length) {
      return;
    }
    this.endTextEditing();
    this.clearBrowserSelection();
    this.selected = undefined;
    this.selectedStroke = undefined;
    this.selectedShape = undefined;
    this.selectedImage = undefined;
    if (objects.length > 1) {
      this.selection?.selectObjects(objects);
    } else {
      this.selection?.clear();
      const [object] = objects as [PdfObject];
      if (object.kind === 'text') {
        this.selected = object.id;
      } else if (object.kind === 'ink') {
        this.selectedStroke = object.id;
      } else if (object.kind === 'shape') {
        this.selectedShape = object.id;
      } else {
        this.selectedImage = object.id;
      }
    }
    this.updateStatus();
    this.refresh();
    if (objects.length === 1 && objects[0]!.kind === 'text') {
      for (const entry of this.layers.values()) {
        entry.controls.get(`${objects[0]!.id}:0`)?.frame.focus({ preventScroll: true });
      }
    }
  }
  /** Reveal an offscreen answer page before mounting its editable field and transferring focus. */
  addSuggestedField(page: number, rect: Rect, scroll = false): void {
    if (!this.session || this.session.replacing || this.session.status === 'conflict') {
      return;
    }
    try {
      if (![...this.layers.values()].some((layer) => layer.page.number === page)) {
        this.native.revealPage?.(page);
        this.refresh();
      }
      const entry = [...this.layers.values()].find((layer) => layer.page.number === page);
      if (!entry) {
        return;
      }
      // Filling never arms the tool that creates boxes on arbitrary page clicks.
      const line = { page, rect };
      let field = this.session.snapshot.fields.find((field) => this.answerWidget(field, line) >= 0);
      if (field?.readOnly) {
        return;
      }
      this.setTool('select');
      this.endTextEditing(field?.name);
      if (!field) {
        field = this.adoptAdjacentAnswer(line);
      }
      if (!field) {
        const block = this.sessions.preferences.flowAnswerLines
          ? ruledAnswerBlock(this.answerLines, line, (candidate) =>
              this.session!.snapshot.fields.some(
                (existing) => this.answerWidget(existing, candidate) >= 0,
              ),
            )
          : undefined;
        const area = block?.rect ?? rect;
        const firstHeight =
          area[3] - area[1] - (block ? (block.layout.rows - 1) * block.layout.spacing : 0);
        const size = Math.min(this.fontSize, Math.max(6, (firstHeight - 2) / 1.2));
        field = this.session.add(page, area, size, !!block, 0, block?.layout);
        this.session.formatField(field.name, {
          fontFamily: this.textFamily,
          color: this.textColor,
          alignment: this.textAlignment,
          letterSpacing: this.letterSpacing,
          ...(field.ruled ? {} : { lineSpacing: this.lineSpacing }),
        });
      }
      this.answerFields.add(field.name);
      this.selected = field.name;
      this.selectedStroke = undefined;
      this.updateStatus();
      this.refresh();
      const input = entry.controls.get(`${field.name}:${this.answerWidget(field, line)}`)?.input;
      if (scroll) {
        input?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      input?.focus({ preventScroll: true });
    } catch (error) {
      this.showError(error);
    }
  }

  private formatSelected(format: Partial<TextFormat>, name = this.selected): void {
    if (!name) {
      return;
    }
    try {
      this.session?.formatField(name, format);
      for (const entry of this.layers.values()) {
        for (const control of entry.controls.values()) {
          if (control.input.dataset.pdfField === name) {
            this.growField(entry, control);
          }
        }
      }
      this.scheduleSave();
    } catch (error) {
      this.showError(error);
    }
  }
  private rememberPreferences(): void {
    void this.sessions
      .updatePreferences({
        ...this.sessions.preferences,
        letterSpacing: this.letterSpacing,
        lineSpacing: this.lineSpacing,
        textAlignment: this.textAlignment,
        fontSize: this.fontSize,
        textFamily: this.textFamily,
        textColor: this.textColor,
        penColor: this.penColor,
        markerColor: this.markerColor,
        penWidth: this.penWidth,
        markerWidth: this.markerWidth,
        smoothPen: this.smoothPen,
        holdShapes: this.holdShapes,
        holdHighlighter: this.holdHighlighter,
        snapToText: this.snapToText,
      })
      .catch((error) => this.showError(error));
  }
  private closePopover(): void {
    if (this.popover) {
      this.removeChild(this.popover);
      this.popover = undefined;
    }
    this.propertiesButton.setAttribute('aria-expanded', 'false');
  }
  private openProperties(): void {
    if (this.popover) {
      this.closePopover();
      return;
    }
    if (this.tool === 'marker' || this.tool === 'scribble') {
      this.openBrushMenu(this.tool, this.propertiesButton);
      return;
    }
    const field = this.session?.snapshot.fields.find((field) => field.name === this.selected);
    if (!field && this.tool !== 'text') {
      return;
    }
    const session = this.session!;
    const epoch = session.renderEpoch;
    /** History can replace model objects; resolve the captured identity within this session and epoch. */
    const currentField = () =>
      field ? session.snapshot.fields.find((item) => item.name === field.name) : undefined;
    let signature: string | undefined;
    const valid = () =>
      this.session === session &&
      session.renderEpoch === epoch &&
      !session.replacing &&
      session.status !== 'conflict' &&
      (field
        ? !!currentField() && (!signature || JSON.stringify(currentField()) === signature)
        : !this.selected && this.tool === 'text');
    const formatTarget = (format: Partial<TextFormat>) => {
      if (valid()) {
        this.formatSelected(format, field?.name);
      }
    };
    let release: (() => void) | undefined;
    const changeSpacing = (letterSpacing: number, lineSpacing: number) => {
      if (!valid()) {
        return;
      }
      this.letterSpacing = letterSpacing;
      this.lineSpacing = lineSpacing;
      this.rememberPreferences();
      formatTarget({ letterSpacing, ...(currentField()?.ruled ? {} : { lineSpacing }) });
      this.updateStatus();
    };
    this.openingPopover = true;
    try {
      this.popover = this.addChild(
        new ToolPopover(this.propertiesButton, {
          title: 'Text',
          color: field?.color ?? this.textColor,
          changeColor: (color) => {
            this.textColor = color;
            this.rememberPreferences();
            formatTarget({ color });
            this.updateStatus();
          },
          text: {
            font: field?.fontFamily ?? this.textFamily,
            size: field?.fontSize ?? this.fontSize,
            disabled: field?.readOnly,
            alignment: field ? (field.alignment ?? 'left') : this.textAlignment,
            align: (alignment) => {
              this.textAlignment = alignment;
              this.rememberPreferences();
              formatTarget({ alignment });
            },
            spacing: {
              letter: field ? (field.letterSpacing ?? 0) : this.letterSpacing,
              line: field ? (field.lineSpacing ?? 1.2) : this.lineSpacing,
              disabled: field ? !field.owned || field.readOnly : false,
              lineLocked: !!field?.ruled,
              read: () => {
                const latest = currentField();
                return {
                  letter: field ? (latest?.letterSpacing ?? 0) : this.letterSpacing,
                  line: field ? (latest?.lineSpacing ?? 1.2) : this.lineSpacing,
                  disabled: field ? !latest?.owned || latest.readOnly : false,
                  lineLocked: !!latest?.ruled,
                };
              },
              change: changeSpacing,
              begin: () => {
                if (!valid()) {
                  return false;
                }
                if (field) {
                  this.selected = field.name;
                }
                signature = field ? JSON.stringify(currentField()) : undefined;
                release = session.beginInteraction();
                const editingSpacing =
                  this.native.element.ownerDocument.activeElement?.matches('.pfs-spacing-value');
                for (const entry of this.layers.values()) {
                  for (const control of entry.controls.values()) {
                    if (
                      !editingSpacing &&
                      this.editing === field?.name &&
                      control.input.dataset.pdfField === field?.name
                    ) {
                      const start = control.input.selectionStart;
                      const end = control.input.selectionEnd;
                      control.input.focus({ preventScroll: true });
                      if (start !== null && end !== null) {
                        control.input.setSelectionRange(start, end);
                      }
                    }
                  }
                }
                return true;
              },
              preview: (letterSpacing, lineSpacing) => {
                if (!valid()) {
                  return false;
                }
                this.formatPreview = { name: field?.name, letterSpacing, lineSpacing };
                this.refresh();
                for (const entry of this.layers.values()) {
                  for (const control of entry.controls.values()) {
                    if (control.input.dataset.pdfField === field?.name) {
                      this.growField(entry, control, true);
                    }
                  }
                }
                return true;
              },
              finish: (cancel) => {
                const preview = this.formatPreview;
                this.formatPreview = undefined;
                try {
                  if (!cancel && preview && valid()) {
                    changeSpacing(preview.letterSpacing, preview.lineSpacing);
                  }
                } finally {
                  signature = undefined;
                  release?.();
                  release = undefined;
                  this.refresh();
                }
              },
            },
            change: (fontFamily, fontSize) => {
              this.textFamily = fontFamily;
              this.fontSize = fontSize;
              this.rememberPreferences();
              formatTarget({ fontFamily, fontSize });
              this.updateStatus();
            },
          },
          close: () => this.closePopover(),
        }),
      );
    } finally {
      this.openingPopover = false;
    }
    this.updateStatus();
    this.propertiesButton.setAttribute('aria-expanded', 'true');
  }
  private openBrushMenu(kind: 'marker' | 'scribble', anchor: HTMLElement): void {
    this.closePopover();
    this.openingPopover = true;
    try {
      this.popover = this.addChild(
        new ToolPopover(anchor, {
          title: kind === 'marker' ? 'Highlighter' : 'Pen',
          color: kind === 'marker' ? this.markerColor : this.penColor,
          changeColor: (color) => {
            if (kind === 'marker') {
              this.markerColor = color;
            } else {
              this.penColor = color;
            }
            this.rememberPreferences();
            this.updateStatus();
          },
          widths: {
            values: kind === 'marker' ? [8, 14, 22, 30] : [1, 2, 4, 6],
            value: kind === 'marker' ? this.markerWidth : this.penWidth,
            change: (value) => {
              if (kind === 'marker') {
                this.markerWidth = value;
              } else {
                this.penWidth = value;
              }
              this.rememberPreferences();
              this.updateStatus();
            },
          },
          close: () => this.closePopover(),
          toggles:
            kind === 'marker'
              ? [
                  {
                    label: 'Snap to text',
                    description:
                      'Fit crossed words and lines, using at least the selected thickness. Falls back to freehand when text geometry is unavailable.',
                    value: this.snapToText,
                    change: (value) => {
                      this.snapToText = value;
                      this.rememberPreferences();
                    },
                  },
                  {
                    label: 'Hold for straight line',
                    description: 'Pause at the end before lifting.',
                    value: this.holdHighlighter,
                    change: (value) => {
                      this.holdHighlighter = value;
                      this.rememberPreferences();
                    },
                  },
                ]
              : [
                  {
                    label: 'Smooth ink',
                    description: 'Reduce wobble while keeping your handwriting.',
                    value: this.smoothPen,
                    change: (value) => {
                      this.smoothPen = value;
                      this.rememberPreferences();
                    },
                  },
                  {
                    label: 'Draw & hold shapes',
                    description:
                      'Lines, rectangles, triangles, circles, ellipses and arrows. Keep holding and drag to resize.',
                    value: this.holdShapes,
                    change: (value) => {
                      this.holdShapes = value;
                      this.rememberPreferences();
                    },
                  },
                ],
        }),
      );
    } finally {
      this.openingPopover = false;
    }
    this.updateStatus();
    this.propertiesButton.setAttribute('aria-expanded', 'true');
  }

  private removeSelection(): void {
    try {
      if (this.selection?.objects.length) {
        this.selection.remove();
        return;
      }
      if (this.selectedStroke) {
        this.session?.deleteStroke(this.selectedStroke);
        this.selectedStroke = undefined;
        this.scheduleSave();
      } else if (this.selected) {
        this.focused = undefined;
        this.session?.delete(this.selected, true);
        this.selected = undefined;
        this.scheduleSave();
      }
      this.updateStatus();
      this.refresh();
    } catch (error) {
      this.showError(error);
    }
  }

  private showError(error: unknown): void {
    if (!this.loaded) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (
      this.session?.status === 'conflict' ||
      this.session?.replacing ||
      this.session?.status === 'error'
    ) {
      this.updateStatus();
    } else {
      this.message.textContent = message;
      this.status.textContent = 'Read only / save failed';
    }
    new Notice(message);
  }

  private updateStatus(): void {
    this.syncObjectScope();
    const session = this.session;
    const blocked = session?.status === 'conflict' || !!session?.replacing;
    setProp(this.listGroup, 'hidden', blocked || !this.listTargetNow());
    this.updateHighlightButton();
    const selected = session?.snapshot.fields.find((field) => field.name === this.selected);
    const brush = this.tool === 'marker' || this.tool === 'scribble';
    setProp(
      this.propertiesButton,
      'disabled',
      !session || blocked || (!brush && this.tool !== 'text' && !selected) || !!selected?.readOnly,
    );
    const color = brush
      ? this.tool === 'marker'
        ? this.markerColor
        : this.penColor
      : (selected?.color ?? this.textColor);
    setStyle(this.propertiesButton, '--pdf-tool-color', cssColor(color));
    setAttr(this.propertiesButton, 'aria-haspopup', 'dialog');
    const width = brush
      ? this.tool === 'marker'
        ? this.markerWidth
        : this.penWidth
      : (selected?.fontSize ?? this.fontSize);
    setAttr(
      this.propertiesButton,
      'aria-label',
      brush ? 'Pen and highlighter properties' : 'Text properties',
    );
    setText(
      this.propertiesButton.querySelector('.pfs-tool-value')!,
      `${Number(width.toFixed(1))} pt`,
    );
    for (const [tool, button] of this.tools) {
      if (tool === 'marker' || tool === 'scribble') {
        setStyle(
          button,
          '--pdf-tool-color',
          cssColor(tool === 'marker' ? this.markerColor : this.penColor),
        );
      }
      setAttr(button, 'aria-pressed', String(this.tool === tool));
      setProp(button, 'disabled', !session || blocked);
    }
    setProp(this.editControls, 'hidden', false);
    this.native.element.classList.toggle('pdf-form-studio-editing', !!session);
    setAttr(this.native.element, 'data-pdf-tool', this.tool);
    setProp(this.saveButton, 'disabled', !session?.dirty || blocked);
    const stroke = session?.snapshot.strokes.find((stroke) => stroke.id === this.selectedStroke);
    setProp(
      this.removeButton,
      'disabled',
      (!this.selection?.objects.length && !selected?.owned && !stroke) ||
        !!selected?.readOnly ||
        !!stroke?.readOnly ||
        blocked,
    );
    setProp(this.removeButton, 'hidden', false);
    const removeLabel = withKeys(
      this.selection?.objects.length
        ? 'Delete selection'
        : stroke
          ? 'Delete drawing'
          : 'Delete text box',
      'Delete',
    );
    if (this.removeButton.dataset.label !== removeLabel) {
      this.removeButton.dataset.label = removeLabel;
      setTooltip(this.removeButton, removeLabel, { classes: ['pfs-overlay-tooltip'] });
    }
    setProp(this.undoButton, 'disabled', !session?.canUndoStroke || blocked);
    setProp(this.redoButton, 'disabled', !session?.canRedoStroke || blocked);
    const status = session
      ? {
          saved: 'Saved to PDF',
          saving: 'Saving…',
          unsaved: session.drafted ? 'Draft saved locally · Saving PDF…' : 'Unsaved changes',
          error: 'Save failed',
          conflict: 'File changed',
        }[session.status]
      : 'Loading…';
    // Rebuild the status only when it changes (it is updated on every refresh).
    const statusKey = `${session?.status}|${blocked}|${status}`;
    if (this.status.dataset.key !== statusKey || !this.status.childElementCount) {
      this.status.dataset.key = statusKey;
      this.status.replaceChildren();
      setIcon(
        this.status,
        session?.status === 'saved'
          ? 'check'
          : session?.status === 'error' || blocked
            ? 'triangle-alert'
            : 'loader-circle',
      );
      this.status.removeAttribute('aria-label');
      this.status.dataset.state = session?.status;
      const accessible = this.status.ownerDocument.createElement('span');
      accessible.className = 'pdf-form-studio-sr-only';
      accessible.textContent = status;
      this.status.append(accessible);
      {
        accessible.className = 'pfs-save-label';
        accessible.textContent =
          session?.status === 'saved'
            ? 'Saved'
            : session?.status === 'saving'
              ? 'Saving…'
              : session?.status === 'unsaved'
                ? 'Unsaved'
                : status;
      }
    }
    setText(this.message, session?.error || this.loadError);
    this.message.classList.toggle(
      'is-error',
      !!this.loadError || session?.status === 'error' || blocked,
    );
  }

  private mountToolbar(): void {
    const host = this.native.toolbarHost();
    this.toolbar.classList.toggle('is-fallback', !host);
    if (host) {
      host.append(this.toolbar);
    } else {
      this.native.element.prepend(this.toolbar);
    }
    this.native.element.prepend(this.message);
  }

  private openMenu(anchor: HTMLElement): void {
    this.menu?.hide();
    const menu = (this.menu = new Menu());
    const release = this.session?.beginInteraction();
    menu.onHide(() => release?.());
    const file = this.native.file;
    const original = this.sessions.backupFor(file);
    const recovery = this.sessions.backupFor(file, 'recovery');
    const blocked =
      this.session?.status === 'conflict' ||
      this.session?.replacing ||
      this.session?.status === 'saving';
    menu.addItem((item) =>
      item
        .setTitle('Floating toolbar')
        .setIcon('pin')
        .setChecked(this.sessions.preferences.floatingToolbar)
        .onClick(() => {
          void this.sessions
            .updatePreferences({
              ...this.sessions.preferences,
              floatingToolbar: !this.sessions.preferences.floatingToolbar,
            })
            .catch((error) => this.showError(error));
        }),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle('Reload PDF')
        .setIcon('refresh-cw')
        .setDisabled(!this.session)
        .onClick(() => this.requestReload()),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle('Recovery copies…')
        .setIcon('shield-check')
        .onClick(() => {
          const modal = new RecoveryInfo(this.app, this.sessions, file);
          this.register(() => modal.close());
          modal.open();
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle('Preview original PDF')
        .setIcon('folder-open')
        .setDisabled(!original)
        .onClick(() => {
          if (original) {
            const modal = new RecoveryPreview(this.app, () => this.sessions.readRecovery(file));
            this.register(() => modal.close());
            modal.open();
          }
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle('Restore original backup…')
        .setIcon('history')
        .setDisabled(!original || blocked)
        .onClick(() => this.requestRestore('original')),
    );
    menu.addItem((item) =>
      item
        .setTitle('Undo last restore…')
        .setIcon('undo-2')
        .setDisabled(!recovery || blocked)
        .onClick(() => this.requestRestore('recovery')),
    );
    const bounds = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: bounds.left, y: bounds.bottom }, anchor.ownerDocument);
  }

  private requestRestore(kind: BackupKind): void {
    const modal = new Modal(this.app);
    this.register(() => modal.close());
    const action = kind === 'original' ? 'Restore original backup' : 'Undo last restore';
    modal.setTitle(action + '?');
    modal.contentEl.createEl('p', {
      text: 'This replaces the PDF and discards pending edits. The current saved PDF is kept in the restore recovery slot first, so this action can be reversed.',
    });
    const confirm = modal.contentEl.createEl('button', { text: action, cls: 'mod-warning' });
    confirm.addEventListener('click', () => {
      modal.close();
      this.focused = undefined;
      void this.sessions.restore(this.native.file, kind).catch((error) => this.showError(error));
    });
    modal.open();
  }

  private scheduleSave(): void {
    if (this.timer !== undefined) {
      this.native.element.ownerDocument.defaultView!.clearTimeout(this.timer);
    }
    this.timer = this.native.element.ownerDocument.defaultView!.setTimeout(() => {
      this.timer = undefined;
      void this.session
        ?.checkpoint()
        .then(() => this.session?.save())
        .catch((error) => this.showError(error));
    }, 900);
  }

  private releaseFocus(): void {
    this.focusInteraction?.release();
    this.focusInteraction = undefined;
  }

  private async save(): Promise<void> {
    if (this.timer !== undefined) {
      this.native.element.ownerDocument.defaultView!.clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      await this.session?.save();
    } catch (error) {
      this.showError(error);
    }
  }

  private requestReload(): void {
    if (!this.session) {
      return;
    }
    const reload = () => {
      void this.session!.reload().catch((error) => this.showError(error));
    };
    if (!this.session.dirty) {
      reload();
      return;
    }
    const modal = new Modal(this.app);
    this.register(() => modal.close());
    modal.setTitle('Reload this PDF?');
    modal.contentEl.createEl('p', {
      text: 'Reloading discards the pending text and marks shown here and reads the current PDF from disk.',
    });
    const button = modal.contentEl.createEl('button', {
      text: 'Reload and discard pending edits',
      cls: 'mod-warning',
    });
    button.addEventListener('click', () => {
      modal.close();
      reload();
    });
    modal.open();
  }

  /** Mount nearby pages plus focused, selected or interacting pages without changing the shared model. */
  refresh(): void {
    if (!this.loaded) {
      return;
    }
    // Obsidian may replace toolbar content while refreshing a file.
    if (
      this.native.element.isConnected &&
      (!this.toolbar.isConnected ||
        this.toolbar.parentElement !== (this.native.toolbarHost() ?? this.native.element))
    ) {
      this.mountToolbar();
    }
    const allPages = this.native.pages();
    const nearby = this.native.editablePages?.() ?? allPages;
    const requested = new Set(nearby.map((page) => page.div));
    const all = new Set(allPages.map((page) => page.div));
    const active = this.native.element.ownerDocument.activeElement;
    const selected = new Set(this.selectedObjects().map((object) => `${object.kind}:${object.id}`));
    const retained = new Set<number>(
      this.selection?.gesturePage ? [this.selection.gesturePage] : [],
    );
    for (const field of this.session?.snapshot.fields ?? []) {
      if (field.owned && field.widgets.length === 1 && selected.has(`text:${field.name}`)) {
        retained.add(field.widgets[0]!.page);
      }
    }
    for (const stroke of this.session?.snapshot.strokes ?? []) {
      if (selected.has(`ink:${stroke.id}`)) {
        retained.add(stroke.page);
      }
    }
    for (const entry of this.layers.values()) {
      if (
        all.has(entry.page.div) &&
        (retained.has(entry.page.number) ||
          (!!active && entry.layer.contains(active)) ||
          entry.placing?.() ||
          entry.ink.interacting ||
          [...entry.controls.values()].some((control) => control.preview))
      ) {
        requested.add(entry.page.div);
      }
    }
    const pages = allPages.filter((page) => requested.has(page.div));
    const resume = this.focused && !this.focused.input.isConnected ? this.focused : undefined;
    const alive = new Set(pages.map((page) => page.div));
    for (const [div, entry] of this.layers) {
      if (!alive.has(div) || !entry.layer.isConnected) {
        if (this.focusInteraction && entry.layer.contains(this.focusInteraction.input)) {
          this.releaseFocus();
        }
        entry.cancelPlacement?.();
        entry.shapes?.dispose();
        entry.images?.dispose();
        this.removeChild(entry.ink);
        for (const control of entry.controls.values()) {
          control.dispose?.();
        }
        entry.layer.remove();
        entry.highlights?.remove();
        this.layers.delete(div);
      }
    }
    if (!this.session) {
      return;
    }
    for (const page of pages) {
      let entry = this.layers.get(page.div);
      if (!entry) {
        const layer = page.div.ownerDocument.createElement('div');
        layer.className = 'pdf-form-studio-layer';
        layer.tabIndex = -1;
        page.div.append(layer);
        const ink = this.addChild(
          new InkLayer(page, layer, this.session, {
            tool: () => this.tool,
            width: (kind) => (kind === 'marker' ? this.markerWidth : this.penWidth),
            color: (kind) => (kind === 'marker' ? this.markerColor : this.penColor),
            selected: () => this.selectedStroke,
            smooth: () => this.smoothPen,
            shapes: () => this.holdShapes,
            straightHold: () => this.holdHighlighter,
            snapText: () => this.snapToText,
            select: (id) => {
              if (id) {
                this.clearBrowserSelection();
              }
              this.selection?.clear();
              this.selectedStroke = id;
              this.selected = undefined;
              this.focused = undefined;
              this.updateStatus();
              this.refresh();
            },
            start: () => {
              this.focused = undefined;
              this.selected = undefined;
              this.selectedStroke = undefined;
              const active = layer.ownerDocument.activeElement;
              if (
                active instanceof layer.ownerDocument.defaultView!.HTMLElement &&
                this.native.element.contains(active)
              ) {
                active.blur();
              }
              this.updateStatus();
            },
            changed: () => {
              if (this.session?.dirty) {
                this.scheduleSave();
              }
            },
            remove: (id) => {
              this.selectedStroke = id;
              this.removeSelection();
            },
            error: (error) => this.showError(error),
          }),
        );
        entry = { page, layer, controls: new Map(), choices: new Map(), marks: new Map(), ink };
        this.layers.set(page.div, entry);
        this.bindPlacement(entry);
        this.bindMarks(page.div, layer);
        entry.shapes = this.shapeLayer(page, layer);
        entry.images = this.imageLayer(page, layer);
      }
      entry.page = page;
      setAttr(entry.layer, 'data-tool', this.tool);
      entry.ink.update(page);
      const fieldWidgets = this.session.snapshot.fields
        .filter((field) => !field.readOnly)
        .flatMap((field) =>
          field.widgets.flatMap((widget, index) =>
            widget.page === page.number ? [{ field, widget, key: `${field.name}:${index}` }] : [],
          ),
        );
      const keys = new Set(fieldWidgets.map(({ key }) => key));
      for (const [key, control] of entry.controls) {
        if (!keys.has(key)) {
          if (this.focusInteraction && control.frame.contains(this.focusInteraction.input)) {
            this.releaseFocus();
          }
          this.composing.delete(control.input);
          control.dispose?.();
          control.frame.remove();
          entry.controls.delete(key);
        }
      }
      // Add only the new widget. Replacing the whole layer blurs the previous
      // input mid-tap, loses caret/IME state and can start an unwanted PDF write.
      for (const { field, widget, key } of fieldWidgets) {
        let control = entry.controls.get(key);
        if (!control) {
          this.mountField(entry, field, key);
          control = entry.controls.get(key)!;
        }
        if (!control.preview) {
          this.positionField(entry, control, field, widget.rect, widget.rotation, widget);
        }
        if (!this.composing.has(control.input) && control.input.value !== field.value) {
          control.input.value = field.value;
        }
        setProp(control.input, 'disabled', field.readOnly);
        setProp(
          control.input,
          'readOnly',
          this.session.status === 'conflict' ||
            this.session.replacing ||
            this.editing !== field.name,
        );
        const drawing =
          this.tool === 'marker' || this.tool === 'scribble' || this.tool === 'eraser';
        setProp(control.input, 'tabIndex', !drawing && this.editing === field.name ? 0 : -1);
        setProp(control.frame, 'tabIndex', drawing ? -1 : 0);
        control.frame.classList.toggle(
          'is-answer-field',
          this.answerFields.has(field.name) || !!field.ruled,
        );
        if (this.answerFields.has(field.name) || field.ruled) {
          labelOverlay(
            control.frame,
            field.ruled
              ? 'Ruled answer block. Click to edit; text wraps along the printed lines.'
              : 'Detected answer. Click to edit; Tab or Shift+Tab to change answer lines.',
          );
        }
        control.frame.classList.toggle('is-editing', this.editing === field.name);
        control.frame.classList.toggle('is-empty', !field.value.trim());
        control.frame.classList.toggle('is-selected', field.name === this.selected);
        control.frame.classList.toggle(
          'is-locked',
          this.session.status === 'conflict' ||
            this.session.replacing ||
            field.readOnly ||
            (field.owned && field.widgets.length !== 1),
        );
      }
      this.refreshChoices(entry);
      this.refreshMarks(entry);
      (entry.shapes ??= this.shapeLayer(entry.page, entry.layer)).update(entry.page, this.session);
      (entry.images ??= this.imageLayer(entry.page, entry.layer)).update(entry.page, this.session);
      // Explicit reload/recovery can replace pages. Restore focus only when
      // the user has not deliberately moved it elsewhere.
      const active = page.div.ownerDocument.activeElement;
      if (
        resume?.page === page.number &&
        this.tool !== 'marker' &&
        this.tool !== 'scribble' &&
        this.tool !== 'eraser' &&
        (!active || active === page.div.ownerDocument.body || active === resume.input)
      ) {
        const input = [...entry.controls.values()].find(
          (control) => control.input.dataset.pdfField === resume.name,
        )?.input;
        if (input && !input.disabled) {
          const start = resume.input.selectionStart;
          const end = resume.input.selectionEnd;
          input.focus({ preventScroll: true });
          if (start !== null && end !== null) {
            input.setSelectionRange(start, end);
          }
        }
      }
    }
    this.selection?.update(pages);
    this.popover?.refreshSpacing();
  }

  /** Replace a text box's value with a list edit and run the normal input path (history, autosave). */
  private applyListEdit(input: HTMLTextAreaElement, edit: TextEdit | undefined): boolean {
    if (
      !edit ||
      input.readOnly ||
      input.disabled ||
      (input.maxLength > 0 && edit.value.length > input.maxLength)
    ) {
      return false;
    }
    input.value = edit.value;
    input.setSelectionRange(edit.start, edit.end);
    this.listEditing = true;
    try {
      input.dispatchEvent(new input.ownerDocument.defaultView!.Event('input'));
    } finally {
      this.listEditing = false;
    }
    return true;
  }

  private listTarget(name: string): boolean {
    const field = this.session?.snapshot.fields.find((item) => item.name === name);
    // Detected answer lines keep Tab for moving between lines.
    return !!field && !field.ruled && !this.answerFields.has(name);
  }

  /** Enter continues lists; Tab/Shift+Tab indent; Ctrl/Cmd+Shift+8/7 toggle bullets/numbers. */
  private listKey(event: KeyboardEvent, input: HTMLTextAreaElement, name: string): void {
    if (event.isComposing || event.altKey || !this.listTarget(name)) {
      return;
    }
    const edit = { value: input.value, start: input.selectionStart, end: input.selectionEnd };
    const mod = event.metaKey || event.ctrlKey;
    let handled = false;
    if (event.key === 'Enter' && !mod && !event.shiftKey) {
      handled = this.applyListEdit(input, continueList(edit));
    } else if (event.key === 'Tab' && !mod) {
      handled = this.applyListEdit(input, indent(edit, event.shiftKey ? -1 : 1));
    } else if (mod && event.shiftKey && (event.code === 'Digit8' || event.code === 'Digit7')) {
      handled = this.applyListEdit(
        input,
        toggleList(edit, event.code === 'Digit8' ? 'bullet' : 'number'),
      );
    }
    if (handled) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  /** The text box that list buttons act on: the one being edited or selected. */
  private listTargetNow(): { input: HTMLTextAreaElement; name: string } | undefined {
    const doc = this.native.element.ownerDocument;
    const remembered = this.listInput;
    if (
      remembered?.input.isConnected &&
      this.listTarget(remembered.name) &&
      (doc.activeElement === remembered.input ||
        this.editing === remembered.name ||
        this.selected === remembered.name ||
        this.activeBox === remembered.name)
    ) {
      return remembered;
    }
    const name = this.selected ?? this.activeBox;
    if (!name || !this.listTarget(name)) {
      return undefined;
    }
    for (const entry of this.layers.values()) {
      for (const control of entry.controls.values()) {
        if (
          control.input.dataset.pdfField === name &&
          control.input instanceof doc.defaultView!.HTMLTextAreaElement
        ) {
          return { input: control.input, name };
        }
      }
    }
    return undefined;
  }

  /** Toolbar list action: edit the session value directly, then restore caret and focus. */
  private listAction(action: (edit: TextEdit) => TextEdit): void {
    const target = this.listTargetNow();
    const session = this.session;
    const field = session?.snapshot.fields.find((item) => item.name === target?.name);
    if (!target || !session || !field || field.readOnly) {
      return;
    }
    const { input, name } = target;
    // The textarea keeps its selection after losing focus; fall back to all lines.
    const synced = input.value === field.value;
    const edit = action({
      value: field.value,
      start: synced ? input.selectionStart : 0,
      end: synced ? input.selectionEnd : field.value.length,
    });
    if (field.maxLength !== undefined && edit.value.length > field.maxLength) {
      return;
    }
    try {
      session.setValue(name, edit.value, true);
    } catch (error) {
      this.showError(error);
      return;
    }
    input.value = edit.value;
    input.focus({ preventScroll: true });
    input.setSelectionRange(edit.start, edit.end);
    for (const entry of this.layers.values()) {
      for (const control of entry.controls.values()) {
        if (control.input === input) {
          this.growField(entry, control);
        }
      }
    }
    this.scheduleSave();
    this.updateStatus();
  }

  /** Convert a client point to PDF coordinates on one page layer. */
  private pdfPoint(entry: PageLayer, clientX: number, clientY: number): [number, number] {
    const box = entry.layer.getBoundingClientRect();
    const { viewport } = entry.page;
    const x = ((clientX - box.left) * viewport.width) / (box.width || viewport.width);
    const y = ((clientY - box.top) * viewport.height) / (box.height || viewport.height);
    const [px, py] = viewport.convertToPdfPoint(x, y);
    return [px!, py!];
  }

  private hideSelectionBar(): void {
    this.selectionBar?.element.remove();
    this.selectionBar = undefined;
  }

  /** Cheap check without layout reads: is PDF text selected in this viewer? */
  private hasTextSelection(): boolean {
    const selection = this.native.element.ownerDocument.getSelection();
    if (this.tool !== 'select' || !selection || selection.isCollapsed || !selection.rangeCount) {
      return false;
    }
    return [selection.anchorNode, selection.focusNode].some((node) => {
      const element = node?.nodeType === 1 ? (node as Element) : node?.parentElement;
      return (
        !!element &&
        this.native.element.contains(element) &&
        !!element.closest('.pfs-text-layer, .textLayer')
      );
    });
  }

  private updateHighlightButton(): void {
    if (!this.highlightButton) {
      return;
    }
    const ready = this.hasTextSelection();
    if (!ready) {
      setAttr(this.highlightButton, 'aria-pressed', 'false');
    }
    if (
      this.highlightButton.disabled === !ready &&
      this.highlightButton.dataset.color === String(this.markColor)
    ) {
      return;
    }
    this.highlightButton.dataset.color = String(this.markColor);
    for (const element of [this.highlightButton, this.highlightCommentButton]) {
      element.disabled = !ready;
    }
    this.highlightButton.style.setProperty('--pdf-tool-color', cssColor(this.markColor));
    setTooltip(
      this.highlightButton,
      ready ? 'Highlight selected text' : 'Highlight selected text (select text on the PDF first)',
    );
  }

  private capturePressedSelection(): void {
    const found = this.selectionQuads();
    if (found) {
      this.pressedSelection = { found, time: Date.now() };
    }
  }

  /** Command palette actions for the active PDF; false when the action does not apply. */
  runAction(action: EditorAction, checking: boolean): boolean {
    if (!this.loaded || !this.session || this.session.replacing) {
      return false;
    }
    if (TOOL_ACTIONS.includes(action as EditorTool)) {
      if (!checking) {
        this.setTool(action as EditorTool);
      }
      return true;
    }
    if (action === 'insert-image') {
      if (!checking) {
        this.chooseImageFile();
      }
      return true;
    }
    if (!this.selectionQuads()) {
      return false;
    }
    if (!checking) {
      if (action === 'highlight') {
        this.highlightSelection('toggle');
      } else {
        this.lineSelection(action as 'underline' | 'strikeout');
      }
    }
    return true;
  }

  /** Underline or strike through the selected text; again on marked text removes it. */
  private lineSelection(kind: 'underline' | 'strikeout'): void {
    const pressed =
      this.pressedSelection && Date.now() - this.pressedSelection.time < 30000
        ? this.pressedSelection.found
        : undefined;
    const found = this.selectionQuads() ?? pressed;
    this.pressedSelection = undefined;
    if (found) {
      this.createTextMarks(found.quads, kind);
    }
  }

  private createTextMarks(quads: Map<PageLayer, Rect[]>, kind: TextMarkKind): void {
    const session = this.session!;
    try {
      for (const [entry, rects] of quads) {
        if (session.highlightsAt(entry.page.number, rects, kind).length) {
          session.eraseHighlights(entry.page.number, rects, kind);
          continue;
        }
        session.addMark({ page: entry.page.number, kind, quads: rects, color: this.lineColor });
      }
    } catch (error) {
      this.showError(error);
    }
    this.native.element.ownerDocument.getSelection()?.removeAllRanges();
    this.hideSelectionBar();
    this.updateHighlightButton();
    this.refresh();
    this.scheduleSave();
  }

  private highlightSelection(mode: HighlightMode): void {
    const pressed =
      this.pressedSelection && Date.now() - this.pressedSelection.time < 30000
        ? this.pressedSelection.found
        : undefined;
    const found = this.selectionQuads() ?? pressed;
    this.pressedSelection = undefined;
    if (found) {
      this.createHighlights(found.quads, mode);
    }
    this.updateHighlightButton();
  }

  /** Small colour menu under the toolbar; picking a colour also highlights a current selection. */
  /**
   * Colour menu for the toolbar highlight button. It is a document-level portal at the
   * button's position: inside the toolbar it would be clipped by the scrolling tool row.
   */
  private toggleHighlightColors(anchor: HTMLElement): void {
    if (this.highlightColors) {
      this.closeHighlightColors();
      return;
    }
    const doc = anchor.ownerDocument;
    const menu = doc.createElement('div');
    menu.className = 'pfs-highlight-colors pfs-mark-ui';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Highlight color');
    for (const { name, color } of MARK_COLORS) {
      const swatch = doc.createElement('button');
      swatch.type = 'button';
      swatch.className = 'pfs-mark-swatch';
      swatch.setAttribute('role', 'menuitemradio');
      swatch.setAttribute('aria-checked', String(color.every((v, i) => v === this.markColor[i])));
      swatch.style.backgroundColor = cssColor(color);
      setTooltip(swatch, name);
      swatch.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        this.capturePressedSelection();
      });
      swatch.addEventListener('mousedown', (event) => event.preventDefault());
      swatch.addEventListener('click', () => {
        this.markColor = color;
        this.closeHighlightColors();
        this.highlightSelection('color');
      });
      menu.append(swatch);
    }
    const box = anchor.getBoundingClientRect();
    const view = doc.defaultView!;
    menu.style.left = `${Math.max(4, Math.min(box.left - 60, view.innerWidth - 150))}px`;
    menu.style.top = `${box.bottom + 4}px`;
    doc.body.append(menu);
    this.highlightColors = menu;
    const outside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof view.Node) || (!menu.contains(target) && !anchor.contains(target))) {
        this.closeHighlightColors();
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        this.closeHighlightColors();
      }
    };
    const moved = () => this.closeHighlightColors();
    doc.addEventListener('pointerdown', outside, true);
    doc.addEventListener('keydown', key, true);
    view.addEventListener('resize', moved);
    doc.addEventListener('scroll', moved, true);
    this.closeColors = () => {
      doc.removeEventListener('pointerdown', outside, true);
      doc.removeEventListener('keydown', key, true);
      view.removeEventListener('resize', moved);
      doc.removeEventListener('scroll', moved, true);
    };
  }

  private closeHighlightColors(): void {
    this.closeColors?.();
    this.closeColors = undefined;
    this.highlightColors?.remove();
    this.highlightColors = undefined;
  }

  /** PDF text currently selected on this viewer's pages, as one quad per line per page. */
  private selectionQuads():
    | { quads: Map<PageLayer, Rect[]>; last: { entry: PageLayer; x: number; y: number } }
    | undefined {
    const doc = this.native.element.ownerDocument;
    const selection = doc.getSelection();
    const session = this.session;
    if (
      this.tool !== 'select' ||
      !session ||
      session.status === 'conflict' ||
      session.replacing ||
      !selection ||
      selection.isCollapsed ||
      !selection.rangeCount
    ) {
      return undefined;
    }
    const inText = (node: Node | null) => {
      const element = node?.nodeType === 1 ? (node as Element) : node?.parentElement;
      return (
        !!element &&
        this.native.element.contains(element) &&
        !!element.closest('.pfs-text-layer, .textLayer')
      );
    };
    if (!inText(selection.anchorNode) && !inText(selection.focusNode)) {
      return undefined;
    }
    const rects = [...selection.getRangeAt(0).getClientRects()].filter(
      (rect) => rect.width > 0.5 && rect.height > 0.5,
    );
    const quads = new Map<PageLayer, Rect[]>();
    let last: { entry: PageLayer; x: number; y: number } | undefined;
    for (const entry of this.layers.values()) {
      const box = entry.layer.getBoundingClientRect();
      if (!box.width || !box.height) {
        continue;
      }
      const sx = entry.page.viewport.width / box.width;
      const sy = entry.page.viewport.height / box.height;
      const own: Rect[] = [];
      for (const rect of rects) {
        const cx = (rect.left + rect.right) / 2;
        const cy = (rect.top + rect.bottom) / 2;
        if (cx < box.left || cx > box.right || cy < box.top || cy > box.bottom) {
          continue;
        }
        const start: [number, number] = [(rect.left - box.left) * sx, (rect.top - box.top) * sy];
        const end: [number, number] = [(rect.right - box.left) * sx, (rect.bottom - box.top) * sy];
        own.push(pdfRectangle(entry.page.viewport, start, end));
        last = { entry, x: start[0], y: end[1] };
      }
      const lines = lineQuads(own);
      if (lines.length) {
        quads.set(entry, lines);
      }
    }
    return last && quads.size ? { quads, last } : undefined;
  }

  /** Offer highlight colours and a comment button next to selected PDF text. */
  private updateSelectionBar(): void {
    this.updateHighlightButton();
    const doc = this.native.element.ownerDocument;
    const found = this.selectionQuads();
    if (!found) {
      this.hideSelectionBar();
      return;
    }
    const { quads, last } = found;
    const highlighted = [...quads].some(
      ([entry, rects]) => this.session!.highlightsAt(entry.page.number, rects).length,
    );
    setAttr(this.highlightButton, 'aria-pressed', String(highlighted));
    setTooltip(
      this.highlightButton,
      highlighted ? 'Remove highlight from selected text' : 'Highlight selected text',
    );
    this.hideSelectionBar();
    const bar = doc.createElement('div');
    bar.className = 'pfs-selection-bar pfs-mark-ui';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Highlight selected text');
    for (const { name, color } of MARK_COLORS) {
      const swatch = doc.createElement('button');
      swatch.type = 'button';
      swatch.className = 'pfs-mark-swatch';
      swatch.style.backgroundColor = cssColor(color);
      swatch.classList.toggle(
        'is-active',
        color.every((v, i) => v === this.markColor[i]),
      );
      setTooltip(swatch, `Highlight ${name.toLowerCase()}`);
      swatch.addEventListener('click', () => {
        this.markColor = color;
        this.createHighlights(quads, 'color');
      });
      bar.append(swatch);
    }
    const comment = doc.createElement('button');
    comment.type = 'button';
    comment.className = 'clickable-icon pfs-mark-comment-button';
    setIcon(comment, 'message-square-plus');
    setTooltip(comment, 'Highlight and comment');
    comment.addEventListener('click', () => this.createHighlights(quads, 'comment'));
    bar.append(comment);
    for (const [kind, icon, label] of [
      ['underline', 'underline', 'Underline'],
      ['strikeout', 'strikethrough', 'Strike through'],
    ] as const) {
      const line = doc.createElement('button');
      line.type = 'button';
      line.className = `clickable-icon pfs-mark-${kind}-button`;
      setIcon(line, icon);
      setTooltip(line, label);
      line.addEventListener('click', () => this.createTextMarks(quads, kind));
      bar.append(line);
    }
    // Already highlighted text: offer removing just the selected part.
    if (
      [...quads].some(
        ([entry, rects]) => this.session!.highlightsAt(entry.page.number, rects).length,
      )
    ) {
      const remove = doc.createElement('button');
      remove.type = 'button';
      remove.className = 'clickable-icon pfs-mark-remove-button';
      setIcon(remove, 'eraser');
      setTooltip(remove, 'Remove highlight from selection');
      remove.addEventListener('click', () => this.createHighlights(quads, 'toggle'));
      bar.append(remove);
    }
    // Keep the text selection while pressing the bar.
    for (const type of ['pointerdown', 'mousedown'] as const) {
      bar.addEventListener(type, (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    }
    const width = last.entry.page.viewport.width;
    bar.style.left = `${Math.max(0, Math.min(last.x, width - 250))}px`;
    bar.style.top = `${last.y + 6}px`;
    last.entry.layer.append(bar);
    this.selectionBar = { element: bar, quads };
  }

  /**
   * toggle: highlight, or remove the selected part if it is already highlighted.
   * color: highlight in the chosen colour; already highlighted text in the same colour
   * is removed, in another colour it is re-coloured.
   * comment: highlight and open the comment (or open the existing highlight's comment).
   */
  private createHighlights(quads: Map<PageLayer, Rect[]>, mode: HighlightMode): void {
    const session = this.session!;
    let opened: { entry: PageLayer; id: string } | undefined;
    try {
      for (const [entry, rects] of quads) {
        const existing = session.highlightsAt(entry.page.number, rects);
        if (mode === 'comment' && existing.length) {
          opened = { entry, id: existing[0]!.id };
          continue;
        }
        if (existing.length) {
          const sameColour = existing.every((mark) =>
            mark.color.every((value, i) => Math.abs(value - this.markColor[i]!) < 0.001),
          );
          session.eraseHighlights(entry.page.number, rects);
          if (mode === 'toggle' || sameColour) {
            continue;
          }
        }
        const mark = session.addMark({
          page: entry.page.number,
          kind: 'highlight',
          quads: rects,
          color: this.markColor,
        });
        opened = { entry, id: mark.id };
      }
    } catch (error) {
      this.showError(error);
    }
    this.native.element.ownerDocument.getSelection()?.removeAllRanges();
    this.hideSelectionBar();
    this.updateHighlightButton();
    this.refresh();
    this.scheduleSave();
    if (mode === 'comment' && opened) {
      this.openMarkPopover(opened.entry, opened.id, false);
    }
  }

  /** Clicks on a highlight open its comment; the note tool places a new note. */
  private bindMarks(div: HTMLElement, layer: HTMLElement): void {
    layer.addEventListener('pointerdown', (event) => {
      const entry = this.layers.get(div);
      if (this.tool !== 'note' || event.target !== layer || event.button !== 0 || !entry) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      try {
        const mark = this.session!.addMark({
          page: entry.page.number,
          kind: 'note',
          at: this.pdfPoint(entry, event.clientX, event.clientY),
          color: MARK_COLORS[0]!.color,
        });
        this.setTool('select');
        this.openMarkPopover(entry, mark.id, true);
      } catch (error) {
        this.showError(error);
      }
    });
    if (this.markClickPages.has(div)) {
      return;
    }
    this.markClickPages.add(div);
    this.bindContextMenu(div);
    this.registerDomEvent(div, 'click', (event) => {
      const entry = this.layers.get(div);
      const target = event.target as Element;
      if (
        !entry ||
        this.tool !== 'select' ||
        div.ownerDocument.getSelection()?.isCollapsed === false ||
        target.closest(`.pdf-form-studio-box, .pfs-choice, ${MARK_UI}`)
      ) {
        return;
      }
      const [x, y] = this.pdfPoint(entry, event.clientX, event.clientY);
      const mark = this.session?.snapshot.marks?.find(
        (item) =>
          item.page === entry.page.number &&
          isTextMark(item.kind) &&
          item.quads.some((q) => x >= q[0] && x <= q[2] && y >= q[1] && y <= q[3]),
      );
      if (mark) {
        this.openMarkPopover(entry, mark.id, false);
      }
    });
  }

  /** Right-click menu for shapes, highlights, notes, text boxes, drawings and the page. */
  private bindContextMenu(div: HTMLElement): void {
    // Only remember the pointer here: measuring the page on every move forces layout.
    this.registerDomEvent(div, 'pointermove', (event) => {
      this.hover = { div, x: event.clientX, y: event.clientY };
    });
    this.registerDomEvent(div, 'pointerleave', () => {
      if (this.hover?.div === div) {
        this.hover = undefined;
      }
    });
    this.registerDomEvent(div, 'contextmenu', (event) => {
      const entry = this.layers.get(div);
      const target = event.target as Element;
      if (
        !entry ||
        !this.session ||
        !this.loaded ||
        !(target instanceof div.ownerDocument.defaultView!.Element)
      ) {
        return;
      }
      // Typing keeps the native spelling/clipboard menu; selected PDF text keeps
      // Obsidian's (and PDF++'s) menu for copying text and links.
      const typing = target.closest(
        'input, textarea, [contenteditable="true"]',
      ) as HTMLInputElement | null;
      if (
        (typing && !typing.readOnly) ||
        target.closest('.pfs-choice') ||
        (target.closest('.pfs-mark-ui') && !target.closest('[data-mark-id]')) ||
        (div.ownerDocument.getSelection()?.isCollapsed === false && target.closest('.textLayer'))
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const at = this.pdfPoint(entry, event.clientX, event.clientY);
      this.openContextMenu(entry, this.contextTarget(entry, target, at), at, event);
    });
  }

  private contextTarget(entry: PageLayer, target: Element, [x, y]: Point): ContextTarget {
    const snapshot = this.session!.snapshot;
    const page = entry.page.number;
    const shapeId = target.closest<HTMLElement | SVGElement>('[data-shape-id]')?.dataset.shapeId;
    const shape = shapeId && snapshot.shapes?.find((item) => item.id === shapeId);
    const group = this.selection?.objects ?? [];
    if (shape && group.length > 1 && group.some((item) => item.id === shape.id)) {
      return { kind: 'objects', objects: [...group] };
    }
    if (shape) {
      return { kind: 'shape', shape };
    }
    const imageId = target.closest<HTMLElement>('[data-image-id]')?.dataset.imageId;
    const image = imageId && snapshot.images?.find((item) => item.id === imageId);
    if (image && group.length > 1 && group.some((item) => item.id === image.id)) {
      return { kind: 'objects', objects: [...group] };
    }
    if (image) {
      return { kind: 'image', image };
    }
    const markId = target.closest<HTMLElement>('[data-mark-id]')?.dataset.markId;
    const note = markId && snapshot.marks?.find((item) => item.id === markId);
    if (note) {
      return { kind: 'mark', mark: note };
    }
    const fieldName = target
      .closest('.pdf-form-studio-box')
      ?.querySelector<HTMLElement>('[data-pdf-field]')?.dataset.pdfField;
    const field =
      fieldName &&
      snapshot.fields.find((item) => item.name === fieldName && item.owned && !item.readOnly);
    const scale = entry.page.viewport.scale || 1;
    const stroke = field
      ? undefined
      : [...snapshot.strokes]
          .reverse()
          .find(
            (item) =>
              item.page === page &&
              !item.readOnly &&
              !item.hidden &&
              hitsStroke(item.points, [x, y], [x, y], item.width / 2 + 6 / scale),
          );
    if (field || stroke) {
      const object: PdfObject = field
        ? { kind: 'text', id: field.name }
        : { kind: 'ink', id: stroke!.id };
      const selected = this.selectedObjects();
      if (selected.some((item) => item.kind === object.kind && item.id === object.id)) {
        return { kind: 'objects', objects: selected };
      }
      this.selectCreated([object]);
      return { kind: 'objects', objects: [object] };
    }
    const highlight = [...(snapshot.marks ?? [])]
      .reverse()
      .find(
        (item) =>
          item.page === page &&
          isTextMark(item.kind) &&
          item.quads.some((q) => x >= q[0] && x <= q[2] && y >= q[1] && y <= q[3]),
      );
    return highlight ? { kind: 'mark', mark: highlight } : { kind: 'page' };
  }

  private openContextMenu(
    entry: PageLayer,
    target: ContextTarget,
    at: Point,
    event: MouseEvent,
  ): void {
    this.menu?.hide();
    const menu = (this.menu = new Menu());
    const session = this.session!;
    // Sections in a fixed order (Obsidian draws a separator between sections):
    // main action, clipboard, edit, color, arrange, lock, danger.
    let section = 'main';
    const add = (
      title: string,
      icon: string,
      run: () => void,
      options: { disabled?: boolean; checked?: boolean; warning?: boolean } = {},
    ) =>
      menu.addItem((item) => {
        item.setTitle(title).setIcon(icon).setSection(section);
        if (options.disabled) {
          item.setDisabled(true);
        }
        if (options.checked !== undefined) {
          item.setChecked(options.checked);
        }
        if (options.warning) {
          item.setWarning(true);
        }
        item.onClick(() => {
          try {
            run();
          } catch (error) {
            this.showError(error);
          }
          this.scheduleSave();
          this.refresh();
        });
      });
    const label = (title: string) =>
      menu.addItem((item) => item.setTitle(title).setIsLabel(true).setSection(section));
    const next = (name: string) => {
      section = name;
    };
    const page = entry.page.number;
    const canPaste = !!copiedObjects || !!copiedShape || this.clipboardReadable();
    const paste = () => this.pasteHere(page, at);
    const arrange = (kind: 'shape' | 'image', id: string) => {
      next('arrange');
      add('Bring to front', 'bring-to-front', () => session.reorder(kind, id, 'front'));
      add('Send to back', 'send-to-back', () => session.reorder(kind, id, 'back'));
    };
    if (target.kind === 'shape') {
      const { shape } = target;
      const locked = !!shape.locked;
      this.selectedShape = shape.id;
      this.selected = undefined;
      this.selectedStroke = undefined;
      this.selectedImage = undefined;
      if (!locked) {
        add('Properties…', 'sliders-horizontal', () => this.openShapeProperties());
      }
      next('clipboard');
      if (!locked) {
        add('Cut', 'scissors', () => this.cutShape(shape.id));
      }
      add('Copy', 'copy', () => this.copyShape(shape.id));
      add('Paste', 'clipboard-paste', paste, { disabled: !canPaste });
      add('Duplicate', 'copy-plus', () => this.duplicateShape(shape.id));
      if (!locked) {
        next('edit');
        add('Rotate right 90°', 'rotate-cw', () => this.turnShape(shape.id, -90));
        add('Rotate left 90°', 'rotate-ccw', () => this.turnShape(shape.id, 90));
        add('Flip horizontally', 'flip-horizontal-2', () => this.flipShape(shape.id, 'x'));
        add('Flip vertically', 'flip-vertical-2', () => this.flipShape(shape.id, 'y'));
        arrange('shape', shape.id);
      }
      next('lock');
      add(locked ? 'Unlock' : 'Lock', locked ? 'unlock' : 'lock', () =>
        session.updateShape(shape.id, { locked: !locked }),
      );
      if (!locked) {
        next('danger');
        add('Delete', 'trash-2', () => this.deleteShapeSelection(shape.id), { warning: true });
      }
    } else if (target.kind === 'image') {
      const { image } = target;
      const locked = !!image.locked;
      this.selectedImage = image.id;
      this.selectedShape = undefined;
      this.selected = undefined;
      this.selectedStroke = undefined;
      next('clipboard');
      if (!locked) {
        add('Cut', 'scissors', () => this.cutImage(image.id));
      }
      add('Copy', 'copy', () => this.copyImage(image.id));
      add('Paste', 'clipboard-paste', paste, { disabled: !canPaste });
      add('Duplicate', 'copy-plus', () => this.duplicateImage(image.id));
      next('edit');
      if (!locked) {
        add('Rotate right 90°', 'rotate-cw', () => this.turnImage(image.id, -90));
        add('Rotate left 90°', 'rotate-ccw', () => this.turnImage(image.id, 90));
        add('Original size', 'maximize', () => this.originalImageSize(image.id));
      }
      add('Save image to vault', 'download', () => void this.saveImageToVault(image.id));
      if (!locked) {
        arrange('image', image.id);
      }
      next('lock');
      add(locked ? 'Unlock' : 'Lock', locked ? 'unlock' : 'lock', () =>
        session.updateImage(image.id, { locked: !locked }),
      );
      if (!locked) {
        next('danger');
        add('Delete', 'trash-2', () => this.deleteImageSelection(image.id), { warning: true });
      }
    } else if (target.kind === 'mark') {
      const { mark } = target;
      add(mark.comment ? 'Edit comment…' : 'Add comment…', 'message-square', () =>
        this.openMarkPopover(entry, mark.id, false),
      );
      if (isTextMark(mark.kind)) {
        next('clipboard');
        add('Copy text', 'copy', () => void this.copyMarkText(entry, mark, false));
        add('Copy as quote with link', 'quote', () => void this.copyMarkText(entry, mark, true));
      }
      next('color');
      label('Color');
      for (const { name, color } of colorsFor(mark.kind)) {
        add(name, 'palette', () => session.updateMark(mark.id, { color }), {
          checked: color.every((value, index) => Math.abs(value - mark.color[index]!) < 0.01),
        });
      }
      if (isTextMark(mark.kind)) {
        next('edit');
        for (const [kind, title, icon] of [
          ['highlight', 'Turn into highlight', 'highlighter'],
          ['underline', 'Turn into underline', 'underline'],
          ['strikeout', 'Turn into strikethrough', 'strikethrough'],
        ] as const) {
          if (kind !== mark.kind) {
            add(title, icon, () => {
              session.convertMark(
                mark.id,
                kind,
                kind === 'highlight' ? this.markColor : this.lineColor,
              );
            });
          }
        }
      }
      next('danger');
      const deleteLabels: Record<MarkKind, string> = {
        note: 'Delete note',
        highlight: 'Delete highlight',
        underline: 'Delete underline',
        strikeout: 'Delete strikethrough',
      };
      add(deleteLabels[mark.kind], 'trash-2', () => session.deleteMark(mark.id), {
        warning: true,
      });
    } else if (target.kind === 'objects') {
      const { objects } = target;
      const single = objects.length === 1 ? objects[0]! : undefined;
      if (single?.kind === 'text') {
        add('Edit text', 'pencil', () => this.editTextBox(single.id));
        add('Properties…', 'sliders-horizontal', () => this.openProperties());
      }
      next('clipboard');
      add('Cut', 'scissors', () => {
        this.copyObjectsFromMenu(objects);
        this.removeSelection();
      });
      add('Copy', 'copy', () => this.copyObjectsFromMenu(objects));
      add('Paste', 'clipboard-paste', paste, { disabled: !canPaste });
      add('Duplicate', 'copy-plus', () =>
        this.selectCreated(session.pasteObjects(session.copyObjects(objects))),
      );
      const onPage = objects.filter((object) =>
        session.objectRects([object]).every((item) => item.page === page),
      );
      if (onPage.length > 1) {
        next('arrange');
        for (const [mode, title, icon] of [
          ['left', 'Align left', 'align-start-vertical'],
          ['center', 'Align center', 'align-center-vertical'],
          ['right', 'Align right', 'align-end-vertical'],
          ['top', 'Align top', 'align-start-horizontal'],
          ['middle', 'Align middle', 'align-center-horizontal'],
          ['bottom', 'Align bottom', 'align-end-horizontal'],
        ] as const) {
          add(title, icon, () => this.alignObjects(entry, onPage, mode));
        }
        if (onPage.length > 2) {
          add('Distribute horizontally', 'align-horizontal-space-around', () =>
            this.distributeObjects(entry, onPage, 'x'),
          );
          add('Distribute vertically', 'align-vertical-space-around', () =>
            this.distributeObjects(entry, onPage, 'y'),
          );
        }
      }
      next('select');
      add('Select all on page', 'box-select', () => this.selectPage(page));
      if (objects.length > 1) {
        add('Clear selection', 'x', () => this.selection?.clear());
      }
      next('danger');
      add(
        objects.length > 1 ? `Delete ${objects.length} objects` : 'Delete',
        'trash-2',
        () => this.removeSelection(),
        { warning: true },
      );
    } else {
      next('clipboard');
      add('Paste', 'clipboard-paste', paste, { disabled: !canPaste });
      next('insert');
      add('Text box here', 'type', () => this.addTextBoxAt(entry, at));
      add('Note here', 'sticky-note', () => {
        const mark = session.addMark({ page, kind: 'note', at, color: MARK_COLORS[0]!.color });
        this.openMarkPopover(entry, mark.id, true);
      });
      add('Insert image…', 'image-plus', () => this.chooseImageFile({ page, at }));
      next('select');
      add('Select all on page', 'box-select', () => this.selectPage(page));
    }
    // Show the menu first; painting the selection can follow.
    menu.showAtMouseEvent(event);
    this.refresh();
  }

  /** Paste the newest copy at a point: objects copied here, else an image on the clipboard. */
  private pasteHere(page: number, at: Point): void {
    const internal =
      copiedShape ?? (copiedObjects && !copiedObjects.blurred ? copiedObjects : undefined);
    if (internal || !this.clipboardReadable()) {
      this.pasteCopied(page, at);
      return;
    }
    void this.pasteClipboardImage({ page, at }, !!copiedObjects).then((placed) => {
      // No image on the clipboard: fall back to an older copy made here.
      if (!placed && copiedObjects) {
        this.pasteCopied(page, at);
        this.scheduleSave();
        this.refresh();
      }
    });
  }

  private openShapeProperties(): void {
    const button = this.toolbar.querySelector<HTMLElement>('.pfs-shape-options-button');
    if (button && !this.shapeMenu) {
      this.toggleShapeMenu(button);
    }
  }

  private editTextBox(name: string): void {
    for (const entry of this.layers.values()) {
      for (const control of entry.controls.values()) {
        if (control.input.dataset.pdfField === name) {
          this.selected = name;
          control.input.focus({ preventScroll: true });
          return;
        }
      }
    }
  }

  /** Align a group's edges or centres in screen terms (left is left on a turned page too). */
  private alignObjects(
    entry: PageLayer,
    objects: PdfObject[],
    mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom',
  ): void {
    const items = this.screenItems(entry, objects);
    const left = Math.min(...items.map((item) => item.box[0]));
    const right = Math.max(...items.map((item) => item.box[2]));
    const top = Math.min(...items.map((item) => item.box[1]));
    const bottom = Math.max(...items.map((item) => item.box[3]));
    this.moveOnScreen(
      entry,
      items.map(({ object, box }) => {
        const [x0, y0, x1, y1] = box;
        const dx =
          mode === 'left'
            ? left - x0
            : mode === 'right'
              ? right - x1
              : mode === 'center'
                ? (left + right) / 2 - (x0 + x1) / 2
                : 0;
        const dy =
          mode === 'top'
            ? top - y0
            : mode === 'bottom'
              ? bottom - y1
              : mode === 'middle'
                ? (top + bottom) / 2 - (y0 + y1) / 2
                : 0;
        return { object, dx, dy };
      }),
    );
  }

  /** Even gaps between the outermost objects, keeping their order. */
  private distributeObjects(entry: PageLayer, objects: PdfObject[], axis: 'x' | 'y'): void {
    const a = axis === 'x' ? 0 : 1;
    const b = axis === 'x' ? 2 : 3;
    const items = this.screenItems(entry, objects).sort((p, q) => p.box[a] - q.box[a]);
    const span = items.at(-1)!.box[b] - items[0]!.box[a];
    const used = items.reduce((sum, item) => sum + item.box[b] - item.box[a], 0);
    const gap = (span - used) / (items.length - 1);
    let cursor = items[0]!.box[a];
    this.moveOnScreen(
      entry,
      items.map(({ object, box }) => {
        const shift = cursor - box[a];
        cursor += box[b] - box[a] + gap;
        return { object, dx: axis === 'x' ? shift : 0, dy: axis === 'y' ? shift : 0 };
      }),
    );
  }

  private screenItems(entry: PageLayer, objects: PdfObject[]) {
    return this.session!.objectRects(objects).map(({ object, rect }) => ({
      object,
      box: screenRectangle(entry.page.viewport, rect) as Rect,
    }));
  }

  private moveOnScreen(
    entry: PageLayer,
    moves: { object: PdfObject; dx: number; dy: number }[],
  ): void {
    const viewport = entry.page.viewport;
    const [ox, oy] = viewport.convertToPdfPoint(0, 0);
    this.session!.moveEach(
      moves.map(({ object, dx, dy }) => {
        const [px, py] = viewport.convertToPdfPoint(dx, dy);
        return { object, delta: [px! - ox!, py! - oy!] as Point };
      }),
    );
  }

  /** The printed words under a highlight, read from the page's text layer. */
  private markText(entry: PageLayer, mark: PdfMark): string {
    const layer = entry.page.div.querySelector('.pfs-text-layer, .textLayer');
    const boxes = mark.quads.map((quad) => screenRectangle(entry.page.viewport, quad));
    const origin = entry.layer.getBoundingClientRect();
    const scaleX = entry.page.viewport.width / (origin.width || entry.page.viewport.width);
    const scaleY = entry.page.viewport.height / (origin.height || entry.page.viewport.height);
    const words: string[] = [];
    for (const span of layer?.querySelectorAll<HTMLElement>('span') ?? []) {
      if (span.children.length) {
        continue;
      }
      const r = span.getBoundingClientRect();
      const x = ((r.left + r.right) / 2 - origin.left) * scaleX;
      const y = ((r.top + r.bottom) / 2 - origin.top) * scaleY;
      if (boxes.some(([l, t, rr, b]) => x >= l && x <= rr && y >= t && y <= b)) {
        words.push(span.textContent ?? '');
      }
    }
    return normalizeSymbols(words.join(' ').replace(/\s+/g, ' ').trim());
  }

  private async copyMarkText(entry: PageLayer, mark: PdfMark, quote: boolean): Promise<void> {
    const text = this.markText(entry, mark);
    const link = `[[${this.native.file.path}#page=${mark.page}|${this.native.file.basename}, p. ${mark.page}]]`;
    const value = quote ? `> ${text || '…'}\n>\n> — ${link}` : text;
    await this.native.element.ownerDocument.defaultView?.navigator.clipboard?.writeText(value);
  }

  private originalImageSize(id: string): void {
    const session = this.session!;
    const image = session.snapshot.images?.find((item) => item.id === id);
    const stored = image && storedImage(image.source);
    const size = stored && imageSize(stored.bytes);
    if (!image || !size) {
      return;
    }
    const bounds = session.snapshot.pages[image.page - 1]!;
    const sideways = image.rotation === 90 || image.rotation === 270;
    const scale = Math.min(
      0.75,
      (bounds[2] - bounds[0]) / (sideways ? size[1] : size[0]),
      (bounds[3] - bounds[1]) / (sideways ? size[0] : size[1]),
    );
    const w = (sideways ? size[1] : size[0]) * scale;
    const h = (sideways ? size[0] : size[1]) * scale;
    const [x0, y0, x1, y1] = image.box;
    const left = Math.max(bounds[0], Math.min(bounds[2] - w, (x0 + x1) / 2 - w / 2));
    const bottom = Math.max(bounds[1], Math.min(bounds[3] - h, (y0 + y1) / 2 - h / 2));
    session.updateImage(id, { box: [left, bottom, left + w, bottom + h] });
  }

  /** Store a pasted image as a file next to the note's attachments. */
  private async saveImageToVault(id: string): Promise<void> {
    const image = this.session?.snapshot.images?.find((item) => item.id === id);
    const stored = image && storedImage(image.source);
    if (!image || !stored) {
      return;
    }
    try {
      const extension = stored.mime === 'image/png' ? 'png' : 'jpg';
      const path = await this.app.fileManager.getAvailablePathForAttachment(
        `${this.native.file.basename} p${image.page}.${extension}`,
        this.native.file.path,
      );
      await this.app.vault.createBinary(
        path,
        stored.bytes.buffer.slice(
          stored.bytes.byteOffset,
          stored.bytes.byteOffset + stored.bytes.byteLength,
        ) as ArrayBuffer,
      );
      new Notice(`Saved ${path}`);
    } catch (error) {
      this.showError(error);
    }
  }

  private copyObjectsFromMenu(objects: PdfObject[]): void {
    const data = this.session!.copyObjects(objects);
    const text =
      data
        .filter((item) => item.kind === 'text')
        .map((item) => item.value)
        .join('\n') || 'PDF Editor elements';
    copiedShape = undefined;
    const copy: ObjectCopy = {
      token: globalThis.crypto.randomUUID(),
      objects: data,
      text,
      custom: false,
    };
    copiedObjects = copy;
    // Ctrl+V compares the clipboard text with this copy before pasting objects.
    copy.write = Promise.resolve(
      this.native.element.ownerDocument.defaultView?.navigator.clipboard?.writeText?.(text),
    ).catch(() => undefined);
  }

  private copyShape(id: string): void {
    const shape = this.session?.snapshot.shapes?.find((item) => item.id === id);
    if (shape) {
      copiedShape = structuredClone(shape);
      delete copiedShape.locked;
      copiedObjects = undefined;
    }
  }

  private cutShape(id: string): void {
    this.copyShape(id);
    this.deleteShapeSelection(id);
  }

  private deleteShapeSelection(id: string): void {
    this.session!.deleteShape(id);
    if (this.selectedShape === id) {
      this.selectedShape = undefined;
    }
  }

  private duplicateShape(id: string): void {
    const shape = this.session?.snapshot.shapes?.find((item) => item.id === id);
    if (shape) {
      this.placeShape(shape, shape.page);
    }
  }

  /** Paste the last copy at a PDF point (context menu) or offset from the original. */
  private pasteCopied(page: number, at?: Point): void {
    const session = this.session!;
    if (copiedShape) {
      this.placeShape(copiedShape, page, at);
      return;
    }
    const copy = copiedObjects;
    if (!copy?.objects.length) {
      return;
    }
    if (!at) {
      this.selectCreated(session.pasteObjects(copy.objects));
      return;
    }
    // Move the group so its top-left corner sits at the clicked point on this page.
    const left = Math.min(...copy.objects.map((item) => item.rect[0]));
    const top = Math.max(...copy.objects.map((item) => item.rect[3]));
    const bounds = session.snapshot.pages[page - 1]!;
    const right = Math.max(...copy.objects.map((item) => item.rect[2]));
    const bottom = Math.min(...copy.objects.map((item) => item.rect[1]));
    const dx = Math.max(bounds[0] - left, Math.min(bounds[2] - right, at[0] - left));
    const dy = Math.max(bounds[1] - bottom, Math.min(bounds[3] - top, at[1] - top));
    const moved = copy.objects.map((item): CopiedPdfObject => {
      const rect: Rect = [
        item.rect[0] + dx,
        item.rect[1] + dy,
        item.rect[2] + dx,
        item.rect[3] + dy,
      ];
      if (item.kind === 'ink') {
        return { ...item, page, rect, points: item.points.map(([x, y]) => [x + dx, y + dy]) };
      }
      if (item.kind === 'shape') {
        return { ...item, page, rect, shape: shiftShape(item.shape, dx, dy) };
      }
      if (item.kind === 'image') {
        const b = item.image.box;
        return {
          ...item,
          page,
          rect,
          image: { ...item.image, box: [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy] },
        };
      }
      return { ...item, page, rect };
    });
    this.selectCreated(session.pasteObjects(moved, [0, 0]));
  }

  private placeShape(shape: PdfShape, page: number, at?: Point): void {
    const session = this.session!;
    const bounds = session.snapshot.pages[page - 1];
    if (!bounds) {
      return;
    }
    const extent = shape.box ? shapeRect(shape) : shapeExtent(shape);
    const want: Point = at ? [at[0] - extent[0], at[1] - extent[3]] : [12, -12];
    const dx = Math.max(bounds[0] - extent[0], Math.min(bounds[2] - extent[2], want[0]));
    const dy = Math.max(bounds[1] - extent[1], Math.min(bounds[3] - extent[3], want[1]));
    const shift = ([x, y]: [number, number]): [number, number] => [x + dx, y + dy];
    const created = session.addShape({
      page,
      kind: shape.kind,
      ...(shape.box
        ? {
            box: [shape.box[0] + dx, shape.box[1] + dy, shape.box[2] + dx, shape.box[3] + dy],
          }
        : { start: shift(shape.start!), end: shift(shape.end!) }),
      color: shape.color,
      ...(shape.fill ? { fill: shape.fill } : {}),
      width: shape.width,
      opacity: shape.opacity,
      ...(shape.rotation ? { rotation: shape.rotation } : {}),
    });
    this.selectedShape = created.id;
    this.selected = undefined;
    this.selectedStroke = undefined;
  }

  /** Turn a shape by 90° steps (positive is counter-clockwise, as in PDF space). */
  private turnShape(id: string, degrees: number): void {
    const session = this.session!;
    const shape = session.snapshot.shapes?.find((item) => item.id === id);
    if (!shape) {
      return;
    }
    if (shape.box) {
      session.updateShape(id, { rotation: (shape.rotation ?? 0) + degrees });
      return;
    }
    const [cx, cy] = [(shape.start![0] + shape.end![0]) / 2, (shape.start![1] + shape.end![1]) / 2];
    const sign = degrees > 0 ? 1 : -1;
    const turn = ([x, y]: [number, number]): [number, number] => [
      cx - sign * (y - cy),
      cy + sign * (x - cx),
    ];
    session.updateShape(id, { start: turn(shape.start!), end: turn(shape.end!) });
  }

  private flipShape(id: string, axis: 'x' | 'y'): void {
    const session = this.session!;
    const shape = session.snapshot.shapes?.find((item) => item.id === id);
    if (!shape) {
      return;
    }
    if (shape.box) {
      // Rectangles and ellipses are symmetric: mirroring only reverses the rotation.
      if (shape.rotation) {
        session.updateShape(id, { rotation: -shape.rotation });
      }
      return;
    }
    const [cx, cy] = [(shape.start![0] + shape.end![0]) / 2, (shape.start![1] + shape.end![1]) / 2];
    const flip = ([x, y]: [number, number]): [number, number] =>
      axis === 'x' ? [2 * cx - x, y] : [x, 2 * cy - y];
    session.updateShape(id, { start: flip(shape.start!), end: flip(shape.end!) });
  }

  private selectPage(page: number): void {
    const snapshot = this.session!.snapshot;
    const objects: PdfObject[] = [
      ...snapshot.fields
        .filter((field) => field.owned && !field.readOnly && field.widgets[0]?.page === page)
        .map((field): PdfObject => ({ kind: 'text', id: field.name })),
      ...snapshot.strokes
        .filter((stroke) => stroke.page === page && !stroke.readOnly && !stroke.hidden)
        .map((stroke): PdfObject => ({ kind: 'ink', id: stroke.id })),
    ];
    this.selectedShape = undefined;
    this.selectCreated(objects);
  }

  private addTextBoxAt(entry: PageLayer, [x, y]: Point): void {
    const session = this.session!;
    const bounds = session.snapshot.pages[entry.page.number - 1]!;
    const width = Math.min(240, bounds[2] - bounds[0]);
    const height = this.fontSize * 1.4 + 8;
    const left = Math.max(bounds[0], Math.min(bounds[2] - width, x));
    const top = Math.max(bounds[1] + height, Math.min(bounds[3], y + this.fontSize));
    const field = session.add(
      entry.page.number,
      [left, top - height, left + width, top],
      this.fontSize,
      true,
      entry.page.viewport.rotation,
    );
    session.formatField(field.name, {
      fontFamily: this.textFamily,
      color: this.textColor,
      alignment: this.textAlignment,
      letterSpacing: this.letterSpacing,
      ...(field.ruled ? {} : { lineSpacing: this.lineSpacing }),
    });
    this.selected = field.name;
    this.selectedStroke = undefined;
    this.updateStatus();
    this.refresh();
    entry.controls.get(`${field.name}:0`)?.input.focus({ preventScroll: true });
  }

  private imageLayer(page: NativePage, layer: HTMLElement): ImageLayer {
    return new ImageLayer(page, layer, this.session!, {
      tool: () => this.tool,
      selected: () => this.selectedImage,
      select: (id) => this.selectImage(id),
      url: (source) => this.imageUrl(source),
      changed: () => this.scheduleSave(),
      error: (error) => this.showError(error),
    });
  }

  private selectImage(id: string | undefined): void {
    this.selectedImage = id;
    if (id) {
      this.selectedShape = undefined;
      this.selected = undefined;
      this.selectedStroke = undefined;
      this.selection?.clear();
    }
    this.refresh();
  }

  private imageUrl(source: string): string {
    let url = this.imageUrls.get(source);
    const stored = storedImage(source);
    if (!url && stored) {
      const view = this.native.element.ownerDocument.defaultView!;
      try {
        url = view.URL.createObjectURL(
          new view.Blob([stored.bytes as Uint8Array<ArrayBuffer>], { type: stored.mime }),
        );
        this.imageUrls.set(source, url);
      } catch {
        return '';
      }
    }
    return url ?? '';
  }

  private clipboardReadable(): boolean {
    return (
      typeof this.native.element.ownerDocument.defaultView?.navigator.clipboard?.read === 'function'
    );
  }

  /** Is this PDF where a paste should go (focused, or under the pointer without a note caret)? */
  private ownsPaste(target: EventTarget | null): boolean {
    const doc = this.native.element.ownerDocument;
    const view = doc.defaultView!;
    if (!this.loaded || !this.session || !this.session.canEditObjects) {
      return false;
    }
    if (
      target instanceof view.Element &&
      target.closest('input, textarea, select, [contenteditable="true"]') &&
      !(target instanceof view.HTMLInputElement && target.readOnly)
    ) {
      return false;
    }
    if (target instanceof view.Node && this.native.element.contains(target)) {
      return true;
    }
    return !!this.hover && (doc.activeElement === doc.body || !doc.activeElement);
  }

  private pasteEvent(event: ClipboardEvent): void {
    this.pasteSeen = Date.now();
    if (!this.ownsPaste(event.target)) {
      return;
    }
    const file = [...(event.clipboardData?.files ?? [])].find((item) =>
      item.type.startsWith('image/'),
    );
    if (!file) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    void this.placeImageBlob(file);
  }

  /** Keys for a selected picture, and Ctrl+V when the host swallows the paste event. */
  private imageKey(event: KeyboardEvent): void {
    const doc = this.native.element.ownerDocument;
    const view = doc.defaultView!;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === 'v' && !event.altKey && !event.shiftKey && this.ownsPaste(event.target)) {
      const pressed = Date.now();
      view.setTimeout(() => {
        if (
          this.pasteSeen >= pressed ||
          this.objectPasteAt >= pressed ||
          !this.clipboardReadable()
        ) {
          return;
        }
        void this.pasteClipboardImage(undefined, true);
      }, 120);
    }
    const id = this.selectedImage;
    const image = id && this.session?.snapshot.images?.find((item) => item.id === id);
    if (
      !image ||
      event.altKey ||
      (event.target instanceof view.Element &&
        event.target.closest('input, textarea, select, [contenteditable="true"]'))
    ) {
      return;
    }
    const step = event.shiftKey ? 10 : 1;
    const delta: Record<string, Point> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const claim = () => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    try {
      if (mod && ['c', 'x', 'd'].includes(key) && !event.shiftKey) {
        claim();
        if (!event.repeat) {
          if (key === 'c') {
            this.copyImage(image.id);
          } else if (key === 'x') {
            this.cutImage(image.id);
          } else {
            this.duplicateImage(image.id);
          }
        }
      } else if (mod) {
        return;
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        claim();
        this.deleteImageSelection(image.id);
      } else if (event.key === 'Escape') {
        claim();
        this.selectedImage = undefined;
      } else if (delta[event.key]) {
        claim();
        const [dx, dy] = delta[event.key]!;
        const bounds = this.session!.snapshot.pages[image.page - 1]!;
        const box = image.box;
        const x = Math.max(bounds[0] - box[0], Math.min(bounds[2] - box[2], dx));
        const y = Math.max(bounds[1] - box[1], Math.min(bounds[3] - box[3], dy));
        this.session!.updateImage(image.id, {
          box: [box[0] + x, box[1] + y, box[2] + x, box[3] + y],
        });
      } else {
        return;
      }
      this.scheduleSave();
    } catch (error) {
      this.showError(error);
    }
    this.refresh();
  }

  private copyImage(id: string): void {
    const image = this.session?.snapshot.images?.find((item) => item.id === id);
    const stored = image && storedImage(image.source);
    if (!image || !stored) {
      return;
    }
    copiedImage = structuredClone(image);
    copiedObjects = undefined;
    copiedShape = undefined;
    // Other apps receive a PNG; pasting it back here keeps size and turn.
    const view = this.native.element.ownerDocument.defaultView!;
    const clipboard = view.navigator.clipboard;
    if (clipboard?.write && typeof view.ClipboardItem === 'function') {
      void this.pngBlob(
        new view.Blob([stored.bytes as Uint8Array<ArrayBuffer>], { type: stored.mime }),
      )
        .then((png) => clipboard.write([new view.ClipboardItem({ 'image/png': png })]))
        .catch(() => undefined);
    }
  }

  private cutImage(id: string): void {
    this.copyImage(id);
    this.deleteImageSelection(id);
  }

  private deleteImageSelection(id: string): void {
    this.session!.deleteImage(id);
    if (this.selectedImage === id) {
      this.selectedImage = undefined;
    }
  }

  private duplicateImage(id: string): void {
    const session = this.session!;
    const image = session.snapshot.images?.find((item) => item.id === id);
    if (!image) {
      return;
    }
    const bounds = session.snapshot.pages[image.page - 1]!;
    const [x0, y0, x1, y1] = image.box;
    const dx = Math.max(bounds[0] - x0, Math.min(bounds[2] - x1, 12));
    const dy = Math.max(bounds[1] - y0, Math.min(bounds[3] - y1, -12));
    const created = session.addImage({
      page: image.page,
      box: [x0 + dx, y0 + dy, x1 + dx, y1 + dy],
      source: image.source,
      ...(image.rotation ? { rotation: image.rotation } : {}),
    });
    this.selectImage(created.id);
  }

  /** Quarter turn about the centre; the box swaps width and height. */
  private turnImage(id: string, degrees: 90 | -90): void {
    const session = this.session!;
    const image = session.snapshot.images?.find((item) => item.id === id);
    if (!image) {
      return;
    }
    const [x0, y0, x1, y1] = image.box;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const hw = (y1 - y0) / 2;
    const hh = (x1 - x0) / 2;
    session.updateImage(id, {
      box: [cx - hw, cy - hh, cx + hw, cy + hh],
      rotation: (((((image.rotation ?? 0) + degrees) % 360) + 360) % 360) as QuarterTurn,
    });
  }

  /** PNG or JPEG bytes for a picture of any format the browser can draw. */
  private async pictureBytes(blob: Blob): Promise<Uint8Array> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return imageMime(bytes)
      ? bytes
      : new Uint8Array(await (await this.pngBlob(blob)).arrayBuffer());
  }

  private async pngBlob(blob: Blob): Promise<Blob> {
    if (blob.type === 'image/png') {
      return blob;
    }
    const view = this.native.element.ownerDocument.defaultView!;
    const bitmap = await view.createImageBitmap(blob);
    const canvas = this.native.element.ownerDocument.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    return new Promise((resolve, reject) =>
      canvas.toBlob(
        (png) => (png ? resolve(png) : reject(new Error('This picture cannot be read.'))),
        'image/png',
      ),
    );
  }

  private async pasteClipboardImage(
    target?: { page: number; at: Point },
    quiet = false,
  ): Promise<boolean> {
    const clipboard = this.native.element.ownerDocument.defaultView?.navigator.clipboard;
    try {
      for (const item of (await clipboard?.read()) ?? []) {
        const type = item.types.find((entry) => entry.startsWith('image/'));
        if (type) {
          await this.placeImageBlob(await item.getType(type), target);
          return true;
        }
      }
      if (!quiet) {
        this.showError(new Error('There is no image on the clipboard.'));
      }
    } catch (error) {
      if (!quiet) {
        this.showError(error);
      }
    }
    return false;
  }

  private chooseImageFile(target?: { page: number; at: Point }): void {
    const input = this.native.element.ownerDocument.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) {
        void this.placeImageBlob(file, target);
      }
    });
    input.click();
  }

  private async placeImageBlob(blob: Blob, target?: { page: number; at: Point }): Promise<void> {
    try {
      this.placeImage(await this.pictureBytes(blob), target);
    } catch (error) {
      this.showError(error);
    }
  }

  /**
   * Add a picture centred on the clicked point, the pointer, or the visible part of
   * the page in view. A picture copied here comes back at its size and turn.
   */
  placeImage(bytes: Uint8Array, target?: { page: number; at: Point }): PdfImage | undefined {
    const session = this.session;
    if (!session || !this.loaded) {
      return undefined;
    }
    const hovered = this.hover && this.layers.get(this.hover.div);
    const entry =
      (target && [...this.layers.values()].find((item) => item.page.number === target.page)) ??
      hovered ??
      this.visiblePage();
    if (!entry) {
      return undefined;
    }
    const page = entry.page.number;
    const bounds = session.snapshot.pages[page - 1]!;
    const copy =
      copiedImage && storedImage(copiedImage.source)?.bytes.length === bytes.length
        ? copiedImage
        : undefined;
    const same =
      copy && storedImage(copy.source)!.bytes.every((value, index) => value === bytes[index]);
    let width: number;
    let height: number;
    if (same) {
      width = copy.box[2] - copy.box[0];
      height = copy.box[3] - copy.box[1];
    } else {
      const [w, h] = imageSize(bytes) ?? [200, 150];
      // Screen pixels to points (96 → 72 dpi), at most 60 % of the page.
      const scale = Math.min(
        0.75,
        ((bounds[2] - bounds[0]) * 0.6) / w,
        ((bounds[3] - bounds[1]) * 0.6) / h,
      );
      width = Math.max(4, w * scale);
      height = Math.max(4, h * scale);
    }
    const centre: Point =
      target?.at ??
      (hovered ? this.pdfPoint(hovered, this.hover!.x, this.hover!.y) : undefined) ??
      (same && copy.page === page
        ? [(copy.box[0] + copy.box[2]) / 2 + 12, (copy.box[1] + copy.box[3]) / 2 - 12]
        : this.visibleCentre(entry));
    const left = Math.max(bounds[0], Math.min(bounds[2] - width, centre[0] - width / 2));
    const bottom = Math.max(bounds[1], Math.min(bounds[3] - height, centre[1] - height / 2));
    const image = session.addImage({
      page,
      box: [
        left,
        bottom,
        left + Math.min(width, bounds[2] - bounds[0]),
        bottom + Math.min(height, bounds[3] - bounds[1]),
      ],
      bytes,
      ...(same && copy.rotation ? { rotation: copy.rotation } : {}),
    });
    this.setTool('select');
    this.selectImage(image.id);
    this.scheduleSave();
    return image;
  }

  /** The page with the largest visible area. */
  private visiblePage(): PageLayer | undefined {
    const view = this.native.element.getBoundingClientRect();
    let best: PageLayer | undefined;
    let area = -1;
    for (const entry of this.layers.values()) {
      const box = entry.layer.getBoundingClientRect();
      const visible =
        Math.max(0, Math.min(box.right, view.right) - Math.max(box.left, view.left)) *
        Math.max(0, Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top));
      if (visible > area || (visible === area && best && entry.page.number < best.page.number)) {
        best = entry;
        area = visible;
      }
    }
    return best;
  }

  private visibleCentre(entry: PageLayer): Point {
    const view = this.native.element.getBoundingClientRect();
    const box = entry.layer.getBoundingClientRect();
    const left = Math.max(box.left, view.left);
    const right = Math.min(box.right, view.right);
    const top = Math.max(box.top, view.top);
    const bottom = Math.min(box.bottom, view.bottom);
    if (right <= left || bottom <= top) {
      const bounds = this.session!.snapshot.pages[entry.page.number - 1]!;
      return [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
    }
    return this.pdfPoint(entry, (left + right) / 2, (top + bottom) / 2);
  }

  private shapeLayer(page: NativePage, layer: HTMLElement): ShapeLayer {
    return new ShapeLayer(page, layer, this.session!, {
      tool: () => this.tool,
      style: () => this.shapeStyle,
      selected: () => this.selectedShape,
      select: (id) => {
        this.selectedShape = id;
        this.selectedImage = undefined;
        this.selected = undefined;
        this.selectedStroke = undefined;
        this.refresh();
      },
      drawn: (id) => {
        // Like Word: after drawing, the new shape is selected for moving or resizing.
        this.setTool('select');
        this.selectedShape = id;
        this.refresh();
      },
      changed: () => this.scheduleSave(),
      error: (error) => this.showError(error),
    });
  }

  /** Shape kind, outline/filled, colour and line width; also restyles the selected shape. */
  private toggleShapeMenu(anchor: HTMLElement): void {
    if (this.shapeMenu) {
      this.closeShapeMenu();
      return;
    }
    const doc = anchor.ownerDocument;
    const menu = doc.createElement('div');
    menu.className = 'pfs-shape-menu pfs-mark-ui';
    menu.setAttribute('role', 'dialog');
    menu.setAttribute('aria-label', 'Shape options');
    const row = (label: string) => {
      const element = doc.createElement('div');
      element.className = 'pfs-shape-menu-row';
      element.setAttribute('role', 'group');
      element.setAttribute('aria-label', label);
      menu.append(element);
      return element;
    };
    const choice = (parent: HTMLElement, label: string, pressed: boolean, apply: () => void) => {
      const element = doc.createElement('button');
      element.type = 'button';
      element.className = 'clickable-icon pfs-shape-choice';
      element.setAttribute('aria-pressed', String(pressed));
      setTooltip(element, label);
      element.addEventListener('pointerdown', (event) => event.preventDefault());
      element.addEventListener('click', () => {
        apply();
        this.closeShapeMenu();
        this.toggleShapeMenu(anchor);
      });
      parent.append(element);
      return element;
    };
    const selected = () =>
      this.session?.snapshot.shapes?.find((item) => item.id === this.selectedShape);
    const restyle = (update: Parameters<TextSession['updateShape']>[1]) => {
      const shape = selected();
      if (shape) {
        try {
          this.session!.updateShape(shape.id, update);
          this.scheduleSave();
        } catch (error) {
          this.showError(error);
        }
      }
    };
    const kinds = row('Shape');
    for (const { kind, label, icon } of SHAPE_KINDS) {
      setIcon(
        choice(kinds, label, this.shapeStyle.kind === kind, () => {
          this.shapeStyle = { ...this.shapeStyle, kind };
          setIcon(this.tools.get('shape')!, icon);
          this.setTool('shape');
        }),
        icon,
      );
    }
    const fill = row('Fill');
    const boxedKind = this.shapeStyle.kind === 'rectangle' || this.shapeStyle.kind === 'ellipse';
    for (const filled of [false, true]) {
      const element = choice(
        fill,
        filled ? 'Filled' : 'Outline only',
        this.shapeStyle.filled === filled,
        () => {
          this.shapeStyle = { ...this.shapeStyle, filled };
          restyle({ fill: filled ? (selected()?.color ?? this.shapeStyle.color) : null });
        },
      );
      element.classList.add('pfs-shape-fill-choice');
      element.classList.toggle('is-filled', filled);
      element.disabled = !boxedKind && !selected()?.box;
    }
    const colors = row('Color');
    for (const { name, color } of SHAPE_COLORS) {
      const element = choice(
        colors,
        name,
        color.every((v, i) => v === this.shapeStyle.color[i]),
        () => {
          this.shapeStyle = { ...this.shapeStyle, color };
          const shape = selected();
          restyle({ color, ...(shape?.fill ? { fill: color } : {}) });
        },
      );
      element.classList.add('pfs-mark-swatch');
      element.style.backgroundColor = cssColor(color);
    }
    const widths = row('Line width');
    for (const width of SHAPE_WIDTHS) {
      const element = choice(widths, `${width} pt line`, this.shapeStyle.width === width, () => {
        this.shapeStyle = { ...this.shapeStyle, width };
        restyle({ width });
      });
      element.classList.add('pfs-shape-width-choice');
      element.style.setProperty('--pfs-line-width', `${width}px`);
    }
    const box = anchor.getBoundingClientRect();
    const view = doc.defaultView!;
    menu.style.left = `${Math.max(4, Math.min(box.left - 80, view.innerWidth - 200))}px`;
    menu.style.top = `${box.bottom + 4}px`;
    doc.body.append(menu);
    this.shapeMenu = menu;
    const outside = (event: Event) => {
      if (
        !(event.target instanceof view.Node) ||
        (!menu.contains(event.target) && !anchor.contains(event.target))
      ) {
        this.closeShapeMenu();
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        this.closeShapeMenu();
      }
    };
    doc.addEventListener('pointerdown', outside, true);
    doc.addEventListener('keydown', key, true);
    this.closeShapeMenuListeners = () => {
      doc.removeEventListener('pointerdown', outside, true);
      doc.removeEventListener('keydown', key, true);
    };
  }

  private closeShapeMenu(): void {
    this.closeShapeMenuListeners?.();
    this.closeShapeMenuListeners = undefined;
    this.shapeMenu?.remove();
    this.shapeMenu = undefined;
  }

  /** Paint this page's highlights and notes; the background render omits them. */
  private refreshMarks(entry: PageLayer): void {
    const doc = entry.layer.ownerDocument;
    const elements = (entry.marks ??= new Map());
    const marks = (this.session?.snapshot.marks ?? []).filter(
      (mark) => mark.page === entry.page.number,
    );
    const ids = new Set(marks.map((mark) => mark.id));
    const badges = (entry.badges ??= new Map());
    for (const [id, element] of elements) {
      if (!ids.has(id)) {
        element.remove();
        elements.delete(id);
        badges.get(id)?.remove();
        badges.delete(id);
      }
    }
    // The editor layer sits above the text in its own stacking context, where a
    // multiply blend has nothing to darken; highlights live directly on the page.
    const pageDiv = entry.page.div;
    let highlights = entry.highlights;
    if (!highlights || highlights.parentElement !== pageDiv) {
      highlights ??= doc.createElement('div');
      highlights.className = 'pfs-highlights';
      pageDiv.insertBefore(
        highlights,
        pageDiv.querySelector(':scope > .pfs-text-layer, :scope > .textLayer') ?? entry.layer,
      );
      entry.highlights = highlights;
    }
    const { viewport } = entry.page;
    const drawing = this.tool === 'marker' || this.tool === 'scribble' || this.tool === 'eraser';
    for (const mark of marks) {
      const signature = JSON.stringify([
        mark.quads,
        mark.rect,
        mark.color,
        mark.opacity,
        mark.comment,
        viewport.width,
        viewport.height,
        viewport.rotation,
      ]);
      let element = elements.get(mark.id);
      if (!element) {
        element = mark.kind === 'note' ? doc.createElement('button') : doc.createElement('div');
        element.dataset.markId = mark.id;
        if (mark.kind === 'note') {
          entry.layer.prepend(element);
        } else {
          highlights.append(element);
        }
        elements.set(mark.id, element);
      }
      element.classList.toggle('is-passive', drawing);
      if (element.dataset.signature === signature) {
        continue;
      }
      element.dataset.signature = signature;
      element.replaceChildren();
      badges.get(mark.id)?.remove();
      badges.delete(mark.id);
      const color = cssColor(mark.color);
      const open = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openMarkPopover(entry, mark.id, false);
      };
      if (mark.kind === 'note') {
        const [left, top, right, bottom] = screenRectangle(viewport, mark.rect);
        element.className = 'pfs-mark-note pfs-mark-ui';
        (element as HTMLButtonElement).type = 'button';
        Object.assign(element.style, {
          left: `${left}px`,
          top: `${top}px`,
          width: `${right - left}px`,
          height: `${bottom - top}px`,
          backgroundColor: color,
        });
        setIcon(element, 'sticky-note');
        setTooltip(element, mark.comment || 'Comment');
        element.onclick = open;
        continue;
      }
      element.className = 'pfs-mark-highlight';
      for (const quad of mark.quads) {
        let area = quad;
        if (mark.kind === 'underline' || mark.kind === 'strikeout') {
          // A thin band where the saved appearance draws its line.
          const { y, width } = textLine(mark.kind, quad);
          area = [quad[0], y - width / 2, quad[2], y + width / 2];
        }
        const [left, top, right, bottom] = screenRectangle(viewport, area);
        const band = doc.createElement('div');
        band.className = 'pfs-mark-quad';
        Object.assign(band.style, {
          left: `${left}px`,
          top: `${top}px`,
          width: `${right - left}px`,
          height: `${Math.max(1, bottom - top)}px`,
          backgroundColor: color,
          // Same strength as the saved annotation (multiplied, so dark text stays dark).
          opacity: String(mark.opacity),
        });
        element.append(band);
      }
      if (mark.comment) {
        const [, top, right] = screenRectangle(viewport, mark.quads[0]!);
        const badge = doc.createElement('button');
        badge.type = 'button';
        badge.className = 'pfs-mark-badge pfs-mark-ui';
        badge.style.left = `${right - 6}px`;
        badge.style.top = `${top - 10}px`;
        setIcon(badge, 'message-square');
        setTooltip(badge, mark.comment);
        badge.addEventListener('click', open);
        badge.dataset.markBadge = mark.id;
        entry.layer.prepend(badge);
        badges.set(mark.id, badge);
      }
    }
    const popover = this.markPopover;
    if (popover && popover.entry === entry) {
      const mark = marks.find((item) => item.id === popover.id);
      if (!mark) {
        popover.element.remove();
        this.markPopover = undefined;
      } else {
        this.placeMarkPopover(popover.element, entry, mark);
        if (doc.activeElement !== popover.textarea && popover.textarea.value !== mark.comment) {
          popover.textarea.value = mark.comment;
        }
      }
    }
  }

  private placeMarkPopover(element: HTMLElement, entry: PageLayer, mark: PdfMark): void {
    const [left, , , bottom] = screenRectangle(entry.page.viewport, mark.rect);
    element.style.left = `${Math.max(0, Math.min(left, entry.page.viewport.width - 260))}px`;
    element.style.top = `${bottom + 6}px`;
  }

  private openMarkPopover(entry: PageLayer, id: string, created: boolean): void {
    this.closeMarkPopover();
    const mark = this.session?.snapshot.marks?.find((item) => item.id === id);
    if (!mark) {
      return;
    }
    const doc = entry.layer.ownerDocument;
    const element = doc.createElement('div');
    element.className = 'pfs-mark-popover pfs-mark-ui';
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-label', mark.kind === 'note' ? 'Note' : 'Comment');
    if (mark.foreign) {
      const meta = doc.createElement('div');
      meta.className = 'pfs-mark-meta';
      meta.textContent = mark.author ? `By ${mark.author}` : 'Made in another app';
      element.append(meta);
    }
    const textarea = doc.createElement('textarea');
    textarea.className = 'pfs-mark-text';
    textarea.placeholder = 'Add a comment…';
    textarea.value = mark.comment;
    textarea.spellcheck = true;
    textarea.addEventListener('input', () => {
      try {
        this.session!.updateMark(id, { comment: textarea.value });
        this.scheduleSave();
      } catch (error) {
        this.showError(error);
      }
    });
    const row = doc.createElement('div');
    row.className = 'pfs-mark-row';
    for (const { name, color } of colorsFor(mark.kind)) {
      const swatch = doc.createElement('button');
      swatch.type = 'button';
      swatch.className = 'pfs-mark-swatch';
      swatch.style.backgroundColor = cssColor(color);
      setTooltip(swatch, name);
      swatch.addEventListener('click', () => {
        try {
          this.session!.updateMark(id, { color });
          if (mark.kind === 'highlight') {
            this.markColor = color;
          } else if (mark.kind !== 'note') {
            this.lineColor = color;
          }
          this.scheduleSave();
        } catch (error) {
          this.showError(error);
        }
      });
      row.append(swatch);
    }
    const spacer = doc.createElement('span');
    spacer.className = 'pfs-mark-spacer';
    row.append(spacer);
    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.className = 'clickable-icon pfs-mark-delete';
    setIcon(remove, 'trash-2');
    setTooltip(remove, mark.kind === 'note' ? 'Delete note' : 'Delete highlight');
    remove.addEventListener('click', () => {
      try {
        this.session!.deleteMark(id);
        this.scheduleSave();
      } catch (error) {
        this.showError(error);
      }
      this.closeMarkPopover();
    });
    const done = doc.createElement('button');
    done.type = 'button';
    done.className = 'clickable-icon pfs-mark-done';
    setIcon(done, 'check');
    setTooltip(done, 'Done');
    done.addEventListener('click', () => this.closeMarkPopover());
    row.append(remove, done);
    element.append(textarea, row);
    element.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
        event.preventDefault();
        this.closeMarkPopover();
      }
    });
    for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick'] as const) {
      element.addEventListener(type, (event) => event.stopPropagation());
    }
    this.placeMarkPopover(element, entry, mark);
    entry.layer.append(element);
    this.markPopover = { id, element, entry, textarea, created };
    textarea.focus({ preventScroll: true });
  }

  private closeMarkPopover(): void {
    const popover = this.markPopover;
    if (!popover) {
      return;
    }
    this.markPopover = undefined;
    popover.element.remove();
    const mark = this.session?.snapshot.marks?.find((item) => item.id === popover.id);
    // A new note closed without text is discarded instead of leaving an empty comment.
    if (popover.created && mark?.kind === 'note' && !mark.comment.trim()) {
      try {
        this.session!.deleteMark(mark.id);
      } catch {
        /* The document is being replaced. */
      }
    }
    if (this.session?.dirty) {
      this.scheduleSave();
    }
  }

  /** Paint checkboxes, radio buttons, dropdowns and list boxes for one page. */
  private refreshChoices(entry: PageLayer): void {
    const session = this.session;
    const controls = (entry.choices ??= new Map());
    const widgets = (session?.snapshot.choices ?? [])
      .filter((field) => !field.readOnly)
      .flatMap((field) =>
        field.widgets.flatMap((widget, index) =>
          widget.page === entry.page.number
            ? [{ field, widget, key: `${field.name}:${index}` }]
            : [],
        ),
      );
    const keys = new Set(widgets.map(({ key }) => key));
    for (const [key, control] of controls) {
      if (!keys.has(key)) {
        control.frame.remove();
        controls.delete(key);
      }
    }
    const locked = !session || session.status === 'conflict' || session.replacing;
    const drawing = this.tool === 'marker' || this.tool === 'scribble' || this.tool === 'eraser';
    for (const { field, widget, key } of widgets) {
      let control = controls.get(key);
      if (!control) {
        control = this.mountChoice(entry, field.name, key);
        controls.set(key, control);
      }
      this.positionChoice(entry, control, field, widget, locked, drawing);
    }
  }

  private mountChoice(entry: PageLayer, name: string, key: string): ChoiceControl {
    const doc = entry.layer.ownerDocument;
    const field = () => this.session?.snapshot.choices?.find((item) => item.name === name);
    const index = Number(key.slice(key.lastIndexOf(':') + 1));
    const apply = (value: string) => {
      try {
        this.session!.setChoice(name, value);
        this.updateStatus();
        this.refresh();
        this.scheduleSave();
      } catch (error) {
        this.showError(error);
      }
    };
    const stop = (event: Event) => event.stopPropagation();
    const kind = field()?.kind;
    let control: ChoiceControl;
    if (kind === 'checkbox' || kind === 'radio') {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = `pfs-choice pfs-choice-${kind}`;
      button.setAttribute('role', kind);
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const current = field();
        const onValue = current?.widgets[index]?.onValue;
        if (!current || onValue === undefined) {
          return;
        }
        // Checkboxes toggle; radio buttons switch the group to this option.
        apply(kind === 'checkbox' && current.value === onValue ? '' : onValue);
      });
      control = { frame: button };
    } else {
      const frame = doc.createElement('div');
      frame.className = `pfs-choice pfs-choice-${kind ?? 'dropdown'}`;
      const select = doc.createElement('select');
      select.className = 'pfs-choice-select';
      select.addEventListener('change', () => apply(select.value));
      frame.append(select);
      control = { frame, select };
    }
    for (const type of ['pointerdown', 'mousedown', 'dblclick', 'keydown'] as const) {
      control.frame.addEventListener(type, stop);
    }
    labelOverlay(control.frame, name);
    entry.layer.append(control.frame);
    return control;
  }

  private positionChoice(
    entry: PageLayer,
    control: ChoiceControl,
    field: ChoiceField,
    widget: ChoiceWidget,
    locked: boolean,
    drawing: boolean,
  ): void {
    const { viewport } = entry.page;
    const layout = JSON.stringify([
      widget,
      field.value,
      field.options,
      locked,
      drawing,
      viewport.width,
      viewport.height,
      viewport.scale,
      viewport.rotation,
    ]);
    if (control.layout === layout) {
      return;
    }
    control.layout = layout;
    const { frame, select } = control;
    const scale = entry.page.viewport.scale;
    const [left, top, right, bottom] = screenRectangle(entry.page.viewport, widget.rect);
    const angle = (((entry.page.viewport.rotation - widget.rotation) % 360) + 360) % 360;
    const width = angle === 90 || angle === 270 ? bottom - top : right - left;
    const height = angle === 90 || angle === 270 ? right - left : bottom - top;
    frame.style.left = `${angle === 90 || angle === 180 ? right : left}px`;
    frame.style.top = `${angle === 180 || angle === 270 ? bottom : top}px`;
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    frame.style.transform = `rotate(${angle}deg)`;
    frame.style.backgroundColor = widget.backgroundColor ? cssColor(widget.backgroundColor) : '';
    frame.style.borderColor = widget.borderColor ? cssColor(widget.borderColor) : '';
    frame.style.borderWidth = widget.borderColor
      ? `${Math.max(1, (widget.borderWidth ?? 1) * scale)}px`
      : '';
    frame.tabIndex = drawing ? -1 : 0;
    frame.classList.toggle('is-locked', locked);
    if (!select) {
      const on = !!field.value && field.value === widget.onValue;
      const button = frame as HTMLButtonElement;
      button.disabled = locked;
      button.textContent = on ? (widget.mark ?? '✔') : '';
      button.setAttribute('aria-checked', String(on));
      button.style.fontSize = `${Math.min(width, height) * 0.8}px`;
      button.classList.toggle('is-round', field.kind === 'radio' && widget.mark === '●');
      setTooltip(
        button,
        widget.label && field.kind === 'radio' ? `${field.name}: ${widget.label}` : field.name,
      );
      return;
    }
    const options = [{ value: '', label: '—' }, ...field.options];
    if (field.value && !field.options.some((option) => option.value === field.value)) {
      options.push({ value: field.value, label: field.value });
    }
    const signature = JSON.stringify(options);
    if (select.dataset.options !== signature) {
      select.replaceChildren(
        ...options.map(({ value, label }) => {
          const option = select.ownerDocument.createElement('option');
          option.value = value;
          option.textContent = label;
          return option;
        }),
      );
      select.dataset.options = signature;
    }
    if (select.value !== field.value) {
      select.value = field.value;
    }
    select.disabled = locked;
    select.tabIndex = drawing ? -1 : 0;
    const size = widget.fontSize ?? Math.min(12, (widget.rect[3] - widget.rect[1]) * 0.6);
    select.style.fontSize = `${Math.max(6, size) * scale}px`;
  }

  private positionField(
    entry: PageLayer,
    control: FieldControl,
    field: TextField,
    rect: Rect,
    rotation: number,
    widget?: TextWidget,
  ): void {
    if (this.formatPreview?.name === field.name) {
      field = { ...field, ...this.formatPreview };
    }
    // Refresh runs on every keystroke; rewriting identical styles for every box is wasted work.
    const { viewport } = entry.page;
    const layout = JSON.stringify([
      rect,
      rotation,
      viewport.width,
      viewport.height,
      viewport.scale,
      viewport.rotation,
      field.fontFamily,
      widget?.color ?? field.color,
      widget?.fontSize ?? field.fontSize,
      field.fontSize,
      field.alignment,
      widget?.appearance,
      field.ruled,
      field.letterSpacing,
      field.lineSpacing,
    ]);
    if (control.layout === layout) {
      return;
    }
    control.layout = layout;
    const { frame, input } = control;
    const [left, top, right, bottom] = screenRectangle(entry.page.viewport, rect);
    // PDF widget appearance rotation is counterclockwise; viewport/CSS is clockwise.
    const angle = (((entry.page.viewport.rotation - rotation) % 360) + 360) % 360;
    frame.style.left = `${angle === 90 || angle === 180 ? right : left}px`;
    frame.style.top = `${angle === 180 || angle === 270 ? bottom : top}px`;
    frame.style.width = `${angle === 90 || angle === 270 ? bottom - top : right - left}px`;
    frame.style.height = `${angle === 90 || angle === 270 ? right - left : bottom - top}px`;
    frame.style.transform = `rotate(${angle}deg)`;
    input.style.fontFamily = `'${fontFaces[field.fontFamily]}', ${field.fontFamily === 'serif' ? 'serif' : field.fontFamily === 'mono' ? 'monospace' : 'sans-serif'}`;
    const color = widget?.color ?? field.color;
    const size = widget?.fontSize ?? field.fontSize;
    input.style.color = cssColor(color);
    // The caret follows the text colour unless that would be hard to see (white or pale
    // text on the page or the field's own background), then it is dark or light instead.
    const behind = widget?.appearance?.backgroundColor ?? [1, 1, 1];
    const luminance = (c: PdfColor) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    input.style.caretColor =
      Math.abs(luminance(color) - luminance(behind)) >= 0.35
        ? cssColor(color)
        : luminance(behind) > 0.5
          ? '#161616'
          : '#ffffff';
    input.style.fontSize = `${size * entry.page.viewport.scale}px`;
    input.style.textAlign = field.alignment ?? 'left';
    const appearance = widget?.appearance;
    frame.style.backgroundColor = appearance?.backgroundColor
      ? cssColor(appearance.backgroundColor)
      : '';
    frame.style.borderColor = appearance?.borderColor
      ? cssColor(appearance.borderColor)
      : 'transparent';
    frame.style.borderStyle =
      appearance?.borderStyle === 'underline' ? 'solid' : (appearance?.borderStyle ?? 'solid');
    const borderWidth = Math.max(0, appearance?.borderWidth ?? 0) * entry.page.viewport.scale;
    frame.style.borderWidth =
      appearance?.borderStyle === 'underline' ? `0 0 ${borderWidth}px` : `${borderWidth}px`;
    input.style.padding = `${entry.page.viewport.scale}px`;
    const offset = field.ruled
      ? Math.max(0, (field.ruled.spacing - field.fontSize * 1.2) / 2) * entry.page.viewport.scale
      : 0;
    input.style.lineHeight = field.ruled
      ? `${field.ruled.spacing * entry.page.viewport.scale}px`
      : String(field.lineSpacing ?? 1.2);
    input.style.letterSpacing = `${(field.letterSpacing ?? 0) * entry.page.viewport.scale}px`;
    input.style.position = field.ruled ? 'relative' : '';
    input.style.top = field.ruled ? `${-offset}px` : '';
    input.style.height = field.ruled ? `calc(100% + ${offset * 2}px)` : '';
    input.style.clipPath = field.ruled ? `inset(${offset}px 0 ${offset}px 0)` : '';
  }

  private mountField(entry: PageLayer, field: TextField, key: string): void {
    const doc = entry.layer.ownerDocument;
    const frame = doc.createElement('div');
    frame.className = 'pdf-form-studio-box';
    frame.classList.toggle('is-added', field.owned);
    frame.classList.toggle('is-form-field', !field.owned);
    const input =
      field.owned || field.multiline ? doc.createElement('textarea') : doc.createElement('input');
    const control: FieldControl = { frame, input };
    if (input instanceof doc.defaultView!.HTMLInputElement) {
      input.type = 'text';
    }
    input.className = 'pdf-form-studio-field';
    input.dataset.pdfField = field.name;
    input.value = field.value;
    if (field.owned) {
      input.placeholder = ' ';
    }
    input.spellcheck = false;
    if (field.maxLength !== undefined) {
      input.maxLength = field.maxLength;
    }
    input.addEventListener('focus', () => {
      this.activateBox(field.name);
      this.editing = field.name;
      this.releaseFocus();
      this.focusInteraction = { input, release: this.session!.beginInteraction() };
      this.focused = { input, page: entry.page.number, name: field.name };
      input.readOnly = this.session?.status === 'conflict' || !!this.session?.replacing;
      this.selected = field.name;
      this.selectedStroke = undefined;
      this.updateStatus();
      this.refresh();
    });
    input.addEventListener('input', (event) => {
      if ((event as InputEvent).isComposing) {
        return;
      }
      // Bullets pasted from Word/PDFs arrive as special-font symbols; replace them in place.
      const normalized = normalizeSymbols(input.value);
      if (normalized !== input.value) {
        const { selectionStart, selectionEnd } = input;
        input.value = normalized;
        input.setSelectionRange(selectionStart, selectionEnd);
      }
      try {
        this.session!.setValue(field.name, input.value, this.listEditing);
        this.growField(entry, control);
        this.scheduleSave();
      } catch (error) {
        this.showError(error);
      }
    });
    input.addEventListener('compositionend', () => {
      this.composing.delete(input);
      try {
        this.session!.setValue(field.name, input.value);
        this.growField(entry, control);
        this.scheduleSave();
      } catch (error) {
        this.showError(error);
      }
    });
    input.addEventListener('compositionstart', () => {
      this.composing.add(input);
      if (this.timer !== undefined) {
        doc.defaultView!.clearTimeout(this.timer);
        this.timer = undefined;
      }
    });
    input.addEventListener('blur', () => {
      // Explicit clicks, Tab and Escape clear the focus record; retain it when
      // a document reload detaches this control before replacement.
      if (this.focusInteraction?.input === input) {
        this.releaseFocus();
      }
      if (this.loaded && this.session?.dirty && this.session.status !== 'conflict') {
        this.scheduleSave();
      }
    });
    if (input instanceof doc.defaultView!.HTMLTextAreaElement) {
      input.addEventListener('keydown', (event) => this.listKey(event, input, field.name));
      input.addEventListener('focus', () => {
        this.listInput = { input, name: field.name };
        this.updateStatus();
      });
      // Focus leaves after the editor's pointerdown handling; recheck the list buttons then.
      input.addEventListener('blur', () =>
        doc.defaultView!.setTimeout(() => this.updateStatus(), 0),
      );
    }
    input.addEventListener('keydown', (event) => {
      const key = event as KeyboardEvent;
      // Keep Obsidian's note editor from handling typing inside the PDF.
      event.stopPropagation();
      if (key.key === 'Tab' || key.key === 'Escape') {
        this.focused = undefined;
      }
      if ((key.metaKey || key.ctrlKey) && key.key.toLowerCase() === 's') {
        event.preventDefault();
        void this.save();
      }
      if (key.key === 'Escape') {
        input.blur();
      }
    });
    frame.append(input);
    labelOverlay(input, field.owned ? 'PDF answer' : field.name);
    entry.layer.append(frame);
    entry.controls.set(key, control);
    control.dispose = this.bindBox(entry, control, field.name);
  }

  /** Measure editor wrapping with PDF glyph advances, previewing spacing without committing geometry. */
  private measureArea(doc: Document): HTMLTextAreaElement {
    if (this.measure?.ownerDocument === doc && this.measure.isConnected) {
      return this.measure;
    }
    this.measure?.parentElement?.remove();
    const host = doc.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    Object.assign(host.style, {
      position: 'fixed',
      left: '-10000px',
      top: '0',
      width: '4000px',
      height: '4000px',
      overflow: 'hidden',
      visibility: 'hidden',
      pointerEvents: 'none',
      contain: 'strict',
    });
    const measure = doc.createElement('textarea');
    measure.tabIndex = -1;
    Object.assign(measure.style, { position: 'absolute', left: '0', top: '0' });
    host.append(measure);
    doc.body.append(host);
    this.register(() => host.remove());
    return (this.measure = measure);
  }

  private growField(entry: PageLayer, control: FieldControl, preview = false): void {
    let field = this.session?.snapshot.fields.find(
      (field) => field.name === control.input.dataset.pdfField,
    );
    if (
      !field?.owned ||
      field.readOnly ||
      field.widgets.length !== 1 ||
      this.session?.status === 'conflict' ||
      this.session?.replacing ||
      this.composing.has(control.input)
    ) {
      return;
    }
    if (preview && this.formatPreview?.name === field.name) {
      field = { ...field, ...this.formatPreview };
    }
    const widget = field.widgets[0]!;
    const doc = control.input.ownerDocument;
    const style = doc.defaultView!.getComputedStyle(control.input);
    // Measure a separate textarea so fitting never disturbs the real caret,
    // scroll position, composition or native text undo history. It is kept in an
    // isolated (contained) host: adding a fresh element to the document on every
    // keystroke forced Obsidian to lay out the whole window.
    const measure = this.measureArea(doc);
    measure.value = control.input.value;
    Object.assign(measure.style, {
      width: style.width,
      height: '0',
      minHeight: '0',
      maxHeight: 'none',
      minWidth: '0',
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      fontKerning: style.fontKerning,
      fontVariantLigatures: style.fontVariantLigatures,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      padding: style.padding,
      border: '0',
      boxSizing: 'border-box',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      overflow: 'hidden',
      margin: '0',
    });
    const height = Math.max(
      measure.scrollHeight + 1,
      (field.fontSize * (field.lineSpacing ?? 1.2) + 2) * entry.page.viewport.scale,
    );
    const widthOverflow = measure.scrollWidth > measure.clientWidth + 1;
    measure.value = '';
    const viewport = entry.page.viewport;
    const angle = (((viewport.rotation - widget.rotation) % 360) + 360) % 360;
    // scrollHeight is rounded to screen pixels; count whole rows before
    // comparing so fractional zoom cannot create a spare row/false warning.
    const measuredRows = field.ruled
      ? Math.max(1, Math.round((height / viewport.scale - 2) / field.ruled.spacing))
      : 0;
    if (field.ruled && !preview) {
      this.session!.fitRuledField(field.name, measuredRows);
    }
    if (!field.ruled) {
      const screen = growBox(
        screenRectangle(viewport, widget.rect),
        [0, 0, viewport.width, viewport.height],
        height,
        angle,
      );
      const rect = pdfRectangle(viewport, [screen[0], screen[1]], [screen[2], screen[3]]);
      if (preview) {
        this.positionField(entry, control, field, rect, widget.rotation);
      } else {
        this.session!.updateBox(field.name, rect, { multiline: true });
      }
    }
    const overflow =
      widthOverflow ||
      (field.ruled
        ? measuredRows > field.ruled.rows
        : height / viewport.scale > widget.rect[3] - widget.rect[1] + 1);
    control.frame.classList.toggle('is-overflow', overflow);
    if (overflow) {
      control.frame.setAttribute(
        'aria-description',
        'Text exceeds the box or page edge. Widen the box or reduce the text size.',
      );
    } else {
      control.frame.removeAttribute('aria-description');
    }
  }

  private bindBox(entry: PageLayer, control: FieldControl, name: string): () => void {
    const { frame, input } = control;
    const doc = frame.ownerDocument;
    frame.tabIndex = 0;
    frame.setAttribute('role', 'group');
    // Live Preview does not reliably deliver Cmd shortcuts to a focused div.
    // A read-only input receives them without entering answer-text editing.
    const shortcutProxy = doc.createElement('textarea');
    shortcutProxy.className = 'pdf-form-studio-shortcut-proxy';
    shortcutProxy.readOnly = true;
    shortcutProxy.tabIndex = -1;
    shortcutProxy.setAttribute('aria-label', 'Selected PDF text box');
    frame.append(shortcutProxy);
    const owned = this.session!.snapshot.fields.find((field) => field.name === name)!.owned;
    labelOverlay(
      frame,
      owned
        ? 'Text box. Click to select, drag to move, double-click or Enter to edit, Backspace to delete.'
        : 'Form field. Click to edit.',
    );
    const labels: Record<ResizeHandle, string> = {
      n: 'top',
      ne: 'top right',
      e: 'right',
      se: 'bottom right',
      s: 'bottom',
      sw: 'bottom left',
      w: 'left',
      nw: 'top left',
    };
    for (const handle of (owned ? Object.keys(labels) : []) as ResizeHandle[]) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.tabIndex = -1;
      button.className = 'pdf-form-studio-handle';
      button.dataset.resize = handle;
      labelOverlay(button, `Resize text box from ${labels[handle]}`);
      frame.append(button);
    }
    for (const edge of owned ? ['n', 'e', 's', 'w'] : []) {
      const border = doc.createElement('div');
      border.className = 'pdf-form-studio-move-edge';
      border.dataset.edge = edge;
      border.setAttribute('aria-hidden', 'true');
      frame.append(border);
    }
    const select = () => {
      this.clearBrowserSelection();
      this.selection?.clear();
      this.selected = name;
      this.selectedStroke = undefined;
      this.updateStatus();
      this.refresh();
    };
    frame.addEventListener('focus', () => {
      if (!owned && this.session?.status !== 'conflict' && !this.session?.replacing) {
        input.focus({ preventScroll: true });
        return;
      }
      this.activateBox(name);
      this.endTextEditing(name);
      select();
      shortcutProxy.focus({ preventScroll: true });
    });
    shortcutProxy.addEventListener('focus', () => {
      this.releaseFocus();
      this.focusInteraction = { input: shortcutProxy, release: this.session!.beginInteraction() };
      select();
    });
    frame.addEventListener('blur', () => {
      if (this.loaded && this.session?.dirty) {
        this.scheduleSave();
      }
    });
    shortcutProxy.addEventListener('blur', () => {
      if (this.focusInteraction?.input === shortcutProxy) {
        this.releaseFocus();
      }
      if (this.loaded && this.session?.dirty) {
        this.scheduleSave();
      }
    });
    frame.addEventListener('focusout', () => {
      // Focus can move from textarea to its frame/handles during a drag. Only
      // leaving the whole box ends its lifetime; toolbar formatting also retains it.
      queueMicrotask(() => {
        const active = doc.activeElement;
        if (
          this.loaded &&
          this.activeBox === name &&
          active !== doc.body &&
          active !== doc.documentElement &&
          !(
            active &&
            (frame.contains(active) ||
              this.toolbar.contains(active) ||
              (active?.instanceOf(doc.defaultView!.Element) && active.closest('.pfs-tool-popover')))
          )
        ) {
          this.endTextEditing();
        }
      });
    });
    frame.addEventListener('dblclick', (event) => {
      if (
        doc.activeElement === input ||
        this.session?.status === 'conflict' ||
        this.session?.replacing ||
        (event.target as HTMLElement).dataset.resize
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    });
    const point = (event: PointerEvent): [number, number] => {
      const box = entry.layer.getBoundingClientRect();
      return [
        ((event.clientX - box.left) * entry.page.viewport.width) / box.width,
        ((event.clientY - box.top) * entry.page.viewport.height) / box.height,
      ];
    };
    const signature = () =>
      [entry.page.viewport.width, entry.page.viewport.height, entry.page.viewport.rotation].join(
        ':',
      );
    let gesture:
      | {
          pointer: number;
          start: [number, number];
          rect: Rect;
          handle?: ResizeHandle;
          signature: string;
          release: () => void;
        }
      | undefined;
    const cancel = (repaint = true) => {
      const previous = gesture;
      gesture = undefined;
      control.preview = undefined;
      previous?.release();
      if (previous && frame.hasPointerCapture(previous.pointer)) {
        frame.releasePointerCapture(previous.pointer);
      }
      if (previous && this.loaded && repaint) {
        this.refresh();
      }
    };
    frame.addEventListener('pointerdown', (event) => {
      if (
        event.button !== 0 ||
        this.tool === 'marker' ||
        this.tool === 'scribble' ||
        this.tool === 'eraser' ||
        this.session?.status === 'conflict' ||
        this.session?.replacing
      ) {
        return;
      }
      if (event.target === input && this.editing === name) {
        return;
      }
      const field = this.session?.snapshot.fields.find((field) => field.name === name);
      if (!field || field.readOnly) {
        return;
      }
      if (
        (!owned || this.answerFields.has(name) || field.ruled) &&
        !event.shiftKey &&
        !(event.target as HTMLElement).closest('[data-resize], [data-edge]')
      ) {
        event.preventDefault();
        event.stopPropagation();
        this.selection?.clear();
        input.focus({ preventScroll: true });
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      select();
      frame.focus({ preventScroll: true });
      if (!owned || field.widgets.length !== 1 || !this.session!.snapshot.fields.includes(field)) {
        return;
      }
      const viewport = entry.page.viewport;
      const widget = field.widgets[0]!;
      const handle = (event.target as HTMLElement).dataset.resize as ResizeHandle | undefined;
      event.preventDefault();
      event.stopPropagation();
      cancel();
      gesture = {
        pointer: event.pointerId,
        start: point(event),
        rect: screenRectangle(viewport, widget.rect),
        handle: handle ? rotatedHandle(handle, viewport.rotation - widget.rotation) : undefined,
        signature: signature(),
        release: this.session!.beginInteraction(),
      };
      select();
      frame.focus({ preventScroll: true });
      frame.setPointerCapture(event.pointerId);
    });
    frame.addEventListener('pointermove', (event) => {
      if (!gesture || gesture.pointer !== event.pointerId) {
        return;
      }
      if (gesture.signature !== signature()) {
        cancel();
        return;
      }
      const field = this.session!.snapshot.fields.find((field) => field.name === name)!;
      const widget = field.widgets[0]!;
      const viewport = entry.page.viewport;
      const end = point(event);
      if (
        !control.preview &&
        Math.hypot(end[0] - gesture.start[0], end[1] - gesture.start[1]) < 3
      ) {
        return;
      }
      const angle = (((viewport.rotation - widget.rotation) % 360) + 360) % 360;
      const minimum = this.session!.minimumTextBoxSize(name).map(
        (value) => value * viewport.scale,
      ) as [number, number];
      if (angle === 90 || angle === 270) {
        minimum.reverse();
      }
      control.preview = transformBox(
        gesture.rect,
        [0, 0, viewport.width, viewport.height],
        [end[0] - gesture.start[0], end[1] - gesture.start[1]],
        gesture.handle,
        minimum,
      );
      this.positionField(
        entry,
        control,
        field,
        pdfRectangle(
          viewport,
          [control.preview[0], control.preview[1]],
          [control.preview[2], control.preview[3]],
        ),
        widget.rotation,
      );
    });
    frame.addEventListener('pointerup', (event) => {
      if (!gesture || gesture.pointer !== event.pointerId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      try {
        if (control.preview && signature() === gesture.signature) {
          const rect = control.preview;
          control.preview = undefined;
          this.session!.updateBox(
            name,
            pdfRectangle(entry.page.viewport, [rect[0], rect[1]], [rect[2], rect[3]]),
            { multiline: true },
          );
          this.growField(entry, control);
          this.scheduleSave();
        }
      } catch (error) {
        this.showError(error);
      } finally {
        cancel();
      }
    });
    frame.addEventListener('pointercancel', () => cancel());
    frame.addEventListener('lostpointercapture', () => {
      if (gesture && !frame.hasPointerCapture(gesture.pointer)) {
        cancel();
      }
    });
    frame.addEventListener('keydown', (event) => {
      if (event.target !== frame && event.target !== shortcutProxy) {
        return;
      }
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        input.focus({ preventScroll: true });
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
        this.selected = undefined;
        frame.blur();
        this.updateStatus();
        this.refresh();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void this.save();
        return;
      }
      const field = this.session?.snapshot.fields.find((field) => field.name === name);
      if (
        !field?.owned ||
        field.readOnly ||
        field.widgets.length !== 1 ||
        this.session?.status === 'conflict' ||
        this.session?.replacing
      ) {
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        this.session?.delete(name, true);
        this.selected = undefined;
        this.scheduleSave();
        return;
      }
      const direction: Record<string, [number, number]> = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
      const delta = direction[event.key];
      if (!delta) {
        return;
      }
      event.preventDefault();
      const widget = field.widgets[0]!;
      const viewport = entry.page.viewport;
      const step = viewport.scale * (event.shiftKey ? 10 : 1);
      const handle = event.altKey ? (delta[0] ? 'e' : 's') : undefined;
      const minimum = this.session!.minimumTextBoxSize(name).map(
        (value) => value * viewport.scale,
      ) as [number, number];
      const angle = (((viewport.rotation - widget.rotation) % 360) + 360) % 360;
      if (angle === 90 || angle === 270) {
        minimum.reverse();
      }
      const rect = transformBox(
        screenRectangle(viewport, widget.rect),
        [0, 0, viewport.width, viewport.height],
        [delta[0] * step, delta[1] * step],
        handle,
        minimum,
      );
      this.session!.updateBox(name, pdfRectangle(viewport, [rect[0], rect[1]], [rect[2], rect[3]]));
      if (handle) {
        this.growField(entry, control);
      }
      this.scheduleSave();
    });
    control.cancel = () => cancel();
    return () => cancel(false);
  }

  private bindPlacement(entry: PageLayer): void {
    let start: [number, number] | undefined;
    let pointer: number | undefined;
    let preview: HTMLElement | undefined;
    let release: (() => void) | undefined;
    const point = (event: PointerEvent): [number, number] => {
      const box = entry.layer.getBoundingClientRect();
      return [
        Math.max(
          0,
          Math.min(
            entry.page.viewport.width,
            ((event.clientX - box.left) * entry.page.viewport.width) / box.width,
          ),
        ),
        Math.max(
          0,
          Math.min(
            entry.page.viewport.height,
            ((event.clientY - box.top) * entry.page.viewport.height) / box.height,
          ),
        ),
      ];
    };
    entry.layer.addEventListener('pointerdown', (event) => {
      if (
        event.target !== entry.layer ||
        event.button !== 0 ||
        this.tool !== 'text' ||
        !this.session ||
        this.session.status === 'conflict' ||
        this.session.replacing
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      start = point(event);
      pointer = event.pointerId;
      release?.();
      release = this.session?.beginInteraction();
      entry.layer.setPointerCapture(event.pointerId);
    });
    entry.layer.addEventListener('pointermove', (event) => {
      if (!start || pointer !== event.pointerId) {
        return;
      }
      const end = point(event);
      if (Math.abs(end[0] - start[0]) < 12 && Math.abs(end[1] - start[1]) < 12) {
        return;
      }
      if (!preview) {
        preview = entry.layer.ownerDocument.createElement('div');
        preview.className = 'pdf-form-studio-placement';
        entry.layer.append(preview);
      }
      Object.assign(preview.style, {
        left: `${Math.min(start[0], end[0])}px`,
        top: `${Math.min(start[1], end[1])}px`,
        width: `${Math.abs(end[0] - start[0])}px`,
        height: `${Math.abs(end[1] - start[1])}px`,
      });
    });
    entry.layer.addEventListener('pointerup', (event) => {
      if (pointer !== event.pointerId || !start || !this.session) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const end = point(event);
      const dragged = Math.abs(end[0] - start[0]) > 12 || Math.abs(end[1] - start[1]) > 12;
      const scale = entry.page.viewport.scale;
      let screenEnd: [number, number] = end;
      let screenStart: [number, number] = start;
      if (!dragged) {
        screenStart = [start[0], Math.max(0, start[1] - this.fontSize * scale)];
        screenEnd = [
          Math.min(entry.page.viewport.width, start[0] + 240 * scale),
          Math.min(entry.page.viewport.height, start[1] + 6 * scale),
        ];
      }
      const rect = pdfRectangle(entry.page.viewport, screenStart, screenEnd);
      start = undefined;
      pointer = undefined;
      preview?.remove();
      preview = undefined;
      try {
        if (rect[2] - rect[0] < 8 || rect[3] - rect[1] < 8) {
          return;
        }
        const field = this.session.add(
          entry.page.number,
          rect,
          this.fontSize,
          true,
          entry.page.viewport.rotation,
        );
        this.session.formatField(field.name, {
          fontFamily: this.textFamily,
          color: this.textColor,
          alignment: this.textAlignment,
          letterSpacing: this.letterSpacing,
          ...(field.ruled ? {} : { lineSpacing: this.lineSpacing }),
        });
        this.setTool('select');
        this.selected = field.name;
        this.selectedStroke = undefined;
        this.updateStatus();
        this.refresh();
        entry.controls.get(`${field.name}:0`)?.input.focus({ preventScroll: true });
        // A blank box stays in the shared model while focused. Its eventual
        // blur, typing, explicit save or closing the editor commits it.
      } catch (error) {
        this.showError(error);
      } finally {
        release?.();
        release = undefined;
        if (entry.layer.hasPointerCapture(event.pointerId)) {
          entry.layer.releasePointerCapture(event.pointerId);
        }
      }
    });
    const cancel = () => {
      start = undefined;
      pointer = undefined;
      preview?.remove();
      preview = undefined;
      release?.();
      release = undefined;
    };
    entry.layer.addEventListener('pointercancel', cancel);
    entry.layer.addEventListener('lostpointercapture', cancel);
    entry.cancelPlacement = cancel;
    entry.placing = () => !!start;
  }

  onunload(): void {
    this.closePopover();
    this.selection?.cancel();
    this.selection?.clear();
    this.endTextEditing();
    for (const entry of this.layers.values()) {
      entry.ink.cancel();
    }
    this.loaded = false;
    this.releaseFocus();
    if (this.timer !== undefined) {
      this.native.element.ownerDocument.defaultView!.clearTimeout(this.timer);
    }
    this.unsubscribe?.();
    // Commit edits when a note/embed closes; errors remain in the shared session.
    if (this.session?.dirty) {
      void this.session
        .checkpoint()
        .then(() => this.session?.saveWhenIdle())
        .catch(() => {});
    }
    for (const url of this.imageUrls.values()) {
      this.native.element.ownerDocument.defaultView?.URL.revokeObjectURL(url);
    }
    this.imageUrls.clear();
    for (const entry of this.layers.values()) {
      entry.cancelPlacement?.();
      entry.shapes?.dispose();
      entry.images?.dispose();
      this.removeChild(entry.ink);
      for (const control of entry.controls.values()) {
        control.dispose?.();
      }
      entry.layer.remove();
      entry.highlights?.remove();
    }
    this.layers.clear();
    this.toolbar.remove();
    this.message.remove();
    this.composing.clear();
    this.native.element.classList.remove('pdf-form-studio-view', 'pdf-form-studio-editing');
    delete this.native.element.dataset.pdfTool;
  }

  /** Discard transient previews and release every active gesture before blur, zoom or replacement. */
  cancelInteractions(): void {
    this.popover?.cancelScrub();
    this.selection?.cancel();
    for (const entry of this.layers.values()) {
      entry.cancelPlacement?.();
      entry.ink.cancel();
      for (const control of entry.controls.values()) {
        control.cancel?.();
      }
    }
  }
}
