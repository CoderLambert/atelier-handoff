/**
 * @file 定义 Markdown 渲染器的独立双语消息接口。
 * @implementation 提供完整 Streamdown 控件和降级消息，允许消费者按语言选择并覆盖个别词条。
 * @updated 2026-11-22T23:00:00+08:00
 */
import type { StreamdownTranslations } from 'streamdown';

export type MarkdownLocale = 'zh-CN' | 'en';
export interface MarkdownMessages extends StreamdownTranslations {
  imageFallback: string;
  diagramError: string;
  diagramTooLarge: string;
  diagramCustomConfig: string;
}

export const markdownMessages = {
  'zh-CN': {
    close: '关闭',
    copied: '已复制',
    copyCode: '复制代码',
    copyLink: '复制链接',
    copyTable: '复制表格',
    copyTableAsCsv: '复制为 CSV',
    copyTableAsMarkdown: '复制为 Markdown',
    copyTableAsTsv: '复制为 TSV',
    downloadDiagram: '下载图表',
    downloadDiagramAsMmd: '下载为 Mermaid',
    downloadDiagramAsPng: '下载为 PNG',
    downloadDiagramAsSvg: '下载为 SVG',
    downloadFile: '下载文件',
    downloadImage: '下载图片',
    downloadTable: '下载表格',
    downloadTableAsCsv: '下载为 CSV',
    downloadTableAsMarkdown: '下载为 Markdown',
    errorMermaid: '图表无法渲染',
    exitFullscreen: '退出全屏',
    externalLinkWarning: '此链接将打开外部网站。',
    imageNotAvailable: '图片不可用',
    mermaidAriaLabel: 'Mermaid 图表',
    mermaidFormatMmd: 'Mermaid 源码',
    mermaidFormatPng: 'PNG 图片',
    mermaidFormatSvg: 'SVG 图片',
    openExternalLink: '打开外部链接',
    openLink: '打开链接',
    resetView: '重置视图',
    tableFormatCsv: 'CSV',
    tableFormatMarkdown: 'Markdown',
    tableFormatTsv: 'TSV',
    viewFullscreen: '全屏查看',
    zoomIn: '放大',
    zoomOut: '缩小',
    imageFallback: '图片',
    diagramError: '图表暂时无法渲染，可以查看 Mermaid 源码。',
    diagramTooLarge: '图表源码超过显示上限。',
    diagramCustomConfig: '图表包含自定义运行配置。',
  },
  en: {
    close: 'Close',
    copied: 'Copied',
    copyCode: 'Copy code',
    copyLink: 'Copy link',
    copyTable: 'Copy table',
    copyTableAsCsv: 'Copy as CSV',
    copyTableAsMarkdown: 'Copy as Markdown',
    copyTableAsTsv: 'Copy as TSV',
    downloadDiagram: 'Download diagram',
    downloadDiagramAsMmd: 'Download as Mermaid',
    downloadDiagramAsPng: 'Download as PNG',
    downloadDiagramAsSvg: 'Download as SVG',
    downloadFile: 'Download file',
    downloadImage: 'Download image',
    downloadTable: 'Download table',
    downloadTableAsCsv: 'Download as CSV',
    downloadTableAsMarkdown: 'Download as Markdown',
    errorMermaid: 'Could not render diagram',
    exitFullscreen: 'Exit fullscreen',
    externalLinkWarning: 'This link opens an external website.',
    imageNotAvailable: 'Image unavailable',
    mermaidAriaLabel: 'Mermaid diagram',
    mermaidFormatMmd: 'Mermaid source',
    mermaidFormatPng: 'PNG image',
    mermaidFormatSvg: 'SVG image',
    openExternalLink: 'Open external link',
    openLink: 'Open link',
    resetView: 'Reset view',
    tableFormatCsv: 'CSV',
    tableFormatMarkdown: 'Markdown',
    tableFormatTsv: 'TSV',
    viewFullscreen: 'View fullscreen',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    imageFallback: 'Image',
    diagramError: 'The diagram cannot be rendered right now. You can view the Mermaid source.',
    diagramTooLarge: 'Diagram source exceeds the display limit.',
    diagramCustomConfig: 'The diagram contains custom runtime configuration.',
  },
} satisfies Record<MarkdownLocale, MarkdownMessages>;
