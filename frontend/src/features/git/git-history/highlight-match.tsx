/**
 * @file 提供分支名与提交信息中的搜索关键词高亮渲染。
 * @implementation 忽略大小写拆分字符串，将命中部分包裹在语义化 mark 元素中。
 * @updated 2026-11-25T02:40:00+08:00
 */
import React from 'react';

export function highlightMatch(text: string, query: string): React.ReactNode {
  const trimmed = query.trim();
  if (!trimmed) return text;
  const lowerText = text.toLowerCase();
  const lowerQuery = trimmed.toLowerCase();
  const index = lowerText.indexOf(lowerQuery);
  if (index === -1) return text;

  const before = text.slice(0, index);
  const match = text.slice(index, index + trimmed.length);
  const after = text.slice(index + trimmed.length);

  return (
    <>
      {before}
      <mark className="git-match-highlight">{match}</mark>
      {highlightMatch(after, query)}
    </>
  );
}
