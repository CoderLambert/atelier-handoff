/**
 * @file Reads explicit, mechanically checkable delivery requirements from a user's own instructions.
 * @implementation Recognizes a small affirmative grammar for handoffs, replies and HTML checks and abstains on ambiguous context.
 * @updated 2026-11-28T19:28:41+08:00
 */
type HtmlCriteria = {
  name: string;
  widths: number[];
  a4: boolean;
  singlePage: boolean;
  offline?: boolean;
};

export type AcceptanceCriteria = {
  replyOnly: boolean;
  exactReply?: string;
  artifacts: string[];
  onlyArtifacts?: true;
  requiredPassages?: { name: string; text: string }[];
  html?: HtmlCriteria;
};

const basename = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,125}\.[a-z0-9]{1,12}$/iu;
const directReply =
  /^(?:(?:请)?(?:只|仅)(?:需)?(?:回复|回答)|(?:please\s+)?(?:(?:only|just)\s+(?:reply|respond|answer)|(?:reply|respond|answer)\s+only)(?:\s+with)?\b)\s*[:：]?\s*/i;
const handoff =
  /^(?:(?:请)?(?:再|然后|并)?(?:只|仅)?(?:需|需要)?(?:生成并)?(?:交付|附上)|(?:please\s+)?(?:then\s+)?(?:only\s+)?(?:deliver|attach)\s+(?:only\s+)?)/i;
const downloadable =
  /^(?:可下载的(?:文件)?\s+|(?:(?:a|the)\s+)?downloadable\s+file\s+(?:named\s+|called\s+)?)/i;
const chatOnly =
  /^(?:请)?(?:只|仅)(?:需)?(?:在(?:聊天|对话)(?:框)?(?:中|里)?)?(?:用(?:文字|文本))?(?:回复|回答)(?:即可)?$|^(?:please )?(?:(?:reply|respond|answer) (?:in (?:the )?chat only|only in (?:the )?chat|with text only)|only (?:reply|respond|answer) in (?:the )?chat)$/i;
const check =
  /^(?:(?:请|要求)?(?:实际)?(?:检查|验证|核对)|(?:please\s+)?(?:actually\s+)?(?:check|verify|test|validate)\b)\s*/i;
const htmlReference =
  /^(?:(?:该|这个|这份)?\s*HTML\s*(?:原件|文件)|(?:the\s+)?(?:original\s+)?HTML\s+(?:file|artifact))$/i;
const htmlDescription =
  /^(?:(?:可离线打开的|离线|单文件|独立的)+\s+|(?:(?:an?|offline,?|single-file|standalone)\s+)+(?:HTML file (?:named |called )?)?|HTML file (?:named |called ))/i;

// A regular expression matching an imperative inside an example, revision or quotation
// does not establish a commitment. Unrecognized surrounding clauses also cause abstention.
const ambiguous =
  /如果|假如|假[设定]|若|除非|可能|例如|示例|举例|参考以下|如下|原计划|之前|原本|曾经|取消|撤[销回掉]|作废|改为|改成|放弃|不用|不要|无需|不必|不再|可选|(?:指令|原话)|\b(?:if|unless|maybe|might|example|hypothetical|suppose|optional|previous(?:ly)?|originally|cancel(?:led)?|instead|ignore|never|skip|omit|not|instructions?|quoted?)\b/i;
const sourceRead = /^(?:读取\s*|read\s+)(?:[\p{L}\p{N}_.-]+\/)*[\p{L}\p{N}_.-]+\.[a-z0-9]{1,12}$/iu;
const arithmetic =
  /^(?:(?:compute|calculate|计算)\s*[\d\s+*/().-]+|[\d\s加减乘除+*/=.-]+等于多少[？?]?)$/i;
const replyForm =
  /^(?:计算结果|结果|答案|结论|译文|文本|文字|一行文字|(?:the\s+)?(?:answer|result|translation|number)|(?:plain\s+)?text)$/i;

function exactLiteral(payload: string): string | undefined {
  if (
    /^[+-]?\d+(?:\.\d+)?$/.test(payload) ||
    /^(?:ok|ack|yes|no|true|false|done|收到|好的)$/i.test(payload)
  )
    return payload;
  const pairs: Record<string, string> = { '"': '"', "'": "'", '“': '”', '「': '」', '`': '`' };
  const first = payload.charAt(0);
  const last = pairs[first];
  const content = payload.slice(1, -1);
  if (
    last &&
    payload.endsWith(last) &&
    content &&
    content.trim() === content &&
    content.length <= 160 &&
    !content.includes(last) &&
    !/[\r\n]/.test(content)
  )
    return content;
  return undefined;
}

function isBasename(value: string): boolean {
  return value.length <= 160 && basename.test(value);
}

function parseNames(value: string): string[] | undefined {
  const names = value
    .split(/[、，,]| (?:and|和) |(?<=\.[a-z0-9]{1,12})(?:和|及)(?=[\p{L}\d])/iu)
    .map((name) => name.trim());
  if (names.length > 12 || !names.every(isBasename)) return undefined;
  return names;
}

function namedHtml(description: string): { name: string; offline: boolean } | undefined {
  const name = description.replace(htmlDescription, '').trim();
  if (!isBasename(name) || !/\.html?$/i.test(name)) return undefined;
  return { name, offline: /离线|\boffline\b/i.test(description.slice(0, -name.length)) };
}

function htmlCreation(clause: string): { name: string; offline: boolean } | undefined {
  const description =
    /^(?:(?:请)?(?:把|将)\s*\S+\s*(?:做成|制作成|转换成)|(?:请)?(?:生成|制作)|(?:please\s+)?(?:convert|turn)\s+\S+\s+(?:to|into)\s+|(?:please\s+)?(?:create|build)\s+)(.+)$/i
      .exec(clause)?.[1]
      ?.trim();
  return description ? namedHtml(description) : undefined;
}

function parseHtmlCheck(requirement: string): Omit<HtmlCriteria, 'name'> | undefined {
  // Match whole verification phrases. A CSS measurement or range cannot become a
  // viewport. Invalid or excessive widths leave the request to the agent.
  const print =
    /(?:^|(?:和|与|及|、|，|,|\band\b)\s*)(?:(单页)\s*)?A4\s*(?:打印(?:预览)?|打印输出)$|(?:^|(?:,|\band\b)\s*)(?:an?\s+)?(?:(single[- ]page)\s+)?A4\s+(?:print(?:out| preview)?|printing)$/i.exec(
      requirement,
    );
  const layout = requirement.slice(0, print?.index ?? requirement.length).trim();
  const widths: number[] = [];
  if (layout) {
    const values =
      /^(?:在\s*)?([\d\s,pPxX，、和与及.-]+?)\s*(?:(?:视口|宽度)下的?|下的?)?(?:布局|视口)$/.exec(
        layout,
      )?.[1] ?? /^(?:the\s+)?(?:layout|viewports?)\s+(?:at\s+)?(.+)$/i.exec(layout)?.[1];
    if (!values) return undefined;
    const parts = values.trim().split(/\s*(?:,|、|，|和|与|及|\band\b)\s*/i);
    if (!parts.every((part) => /^\d{1,4}\s*px$/i.test(part))) return undefined;
    for (const part of parts) {
      const width = parseInt(part, 10);
      if (width < 1 || width > 4096) return undefined;
      widths.push(width);
    }
  }
  if (!widths.length && !print) return undefined;
  return { widths, a4: Boolean(print), singlePage: Boolean(print?.[1] || print?.[2]) };
}

export function readAcceptanceCriteria(text: string): AcceptanceCriteria {
  const none: AcceptanceCriteria = { replyOnly: false, artifacts: [] };
  // Blocks may contain quoted material and Markdown lazy continuations. Leave a mixed
  // message to the model instead of trying to reconstruct the user's authorship.
  if (text.length > 32_000 || /^(?:[ \t]*[>`~]| {4}|\t)/m.test(text) || /[`~]{3}|[<>]/.test(text))
    return none;
  // Only an independent instruction can bind a literal passage to a named deliverable.
  // Leave all other quoted prose in place for the ordinary authorship checks below.
  const passages: NonNullable<AcceptanceCriteria['requiredPassages']> = [];
  const request = text
    .replace(
      /^([^\s/\\]+\.(?:md|txt|csv|json|ya?ml|log))\s+(?:必须包含\s*「([^「」\r\n]{1,160})」|must contain\s+"([^"\r\n]{1,160})")[。.]?[ \t]*$/gimu,
      (line: string, name: string, chinese: string | undefined, english: string | undefined) => {
        const value = chinese ?? english;
        if (!isBasename(name) || !value?.trim()) return line;
        passages.push({ name, text: value });
        return '';
      },
    )
    .trim()
    .replace(/[。.]$/, '')
    .trimEnd();
  const literal = request.match(directReply);
  if (literal) {
    const exactReply = exactLiteral(request.slice(literal[0].length));
    if (exactReply !== undefined)
      return passages.length ? none : { replyOnly: true, exactReply, artifacts: [] };
  }
  const prose = request
    .replace(/`([^\s`]+)`/g, (quoted: string, value: string) =>
      isBasename(value) ? ' ' + value + ' ' : quoted,
    )
    .replace(/[^\S\n]+/g, ' ');
  if (ambiguous.test(prose) || /["'`“”‘’「」『』«»]/.test(prose)) return none;
  const clauses = prose
    .split(
      /[。；;\n]+|\.\s+|[,，]\s*(?=(?:请|只|仅|并|再|然后)?(?:交付|附上)|(?:then\s+)?(?:deliver|attach)\b)/i,
    )
    .map((clause) => clause.trim())
    .filter(Boolean);
  const artifacts = new Set<string>();
  const created: { name: string; offline: boolean }[] = [];
  const exclusive: (string[] | 'html')[] = [];
  const widths = new Set<number>();
  let a4 = false;
  let singlePage = false;
  let requiresHtml = false;
  let replyOnly = false;
  for (const clause of clauses) {
    const delivery = clause.match(handoff);
    if (delivery) {
      const only =
        /(?:只|仅)(?:交付|附上)|\bonly\s+(?:deliver|attach)|(?:deliver|attach)\s+only\b/i.test(
          delivery[0],
        );
      const argument = clause.slice(delivery[0].length);
      const target = argument.trim().replace(downloadable, '');
      if (htmlReference.test(target)) {
        requiresHtml = true;
        if (only) exclusive.push('html');
      } else {
        // A Chinese phrase glued to a suffix (e.g. 交付前读source.md) need not be a filename.
        if (
          /^\p{Script=Han}/u.test(argument) &&
          !downloadable.test(argument) &&
          !htmlDescription.test(target)
        )
          return none;
        const described = htmlDescription.test(target) ? namedHtml(target) : undefined;
        const names = described ? [described.name] : parseNames(target);
        if (!names) return none;
        if (described) created.push(described);
        for (const name of names) artifacts.add(name);
        if (only) exclusive.push(names);
      }
      continue;
    }
    const creation = htmlCreation(clause);
    if (creation) {
      created.push(creation);
      continue;
    }
    const verify = clause.match(check);
    if (verify) {
      const checked = parseHtmlCheck(clause.slice(verify[0].length));
      if (!checked) return none;
      for (const width of checked.widths) widths.add(width);
      a4 ||= checked.a4;
      singlePage ||= checked.singlePage;
      continue;
    }
    const reply = clause.match(directReply);
    if (chatOnly.test(clause) || (reply && replyForm.test(clause.slice(reply[0].length)))) {
      replyOnly = true;
      continue;
    }
    if (sourceRead.test(clause) || arithmetic.test(clause)) continue;
    if (created.length && /^(?:保留|包含)[\p{L}\p{N}、 ]+$/u.test(clause)) continue;
    return none;
  }
  const htmlCandidates = new Set(created.map((candidate) => candidate.name));
  for (const name of artifacts) if (/\.html?$/i.test(name)) htmlCandidates.add(name);
  const [referencedHtml] = htmlCandidates;
  if (requiresHtml) {
    if (!referencedHtml || htmlCandidates.size !== 1) return none;
    artifacts.add(referencedHtml);
  }
  if (replyOnly && (artifacts.size || requiresHtml || created.length)) return none;
  const result: AcceptanceCriteria = { replyOnly, artifacts: [...artifacts] };
  if (exclusive.length) {
    for (const group of exclusive) {
      const names = group === 'html' ? [referencedHtml] : group;
      if (result.artifacts.some((name) => !names.includes(name))) return none;
    }
    result.onlyArtifacts = true;
  }
  if (passages.length) {
    if (passages.length > 12 || passages.some(({ name }) => !artifacts.has(name))) return none;
    result.requiredPassages = passages;
  }
  const [name] = result.artifacts;
  if (name && artifacts.size === 1 && /\.html?$/i.test(name)) {
    const offline = created.some((file) => file.name === name && file.offline);
    if (
      created.every((file) => file.name === name) &&
      widths.size <= 6 &&
      (widths.size || a4 || offline)
    ) {
      result.html = {
        name,
        widths: [...widths],
        a4,
        singlePage,
        ...(offline && { offline: true }),
      };
    }
  }
  return result;
}
