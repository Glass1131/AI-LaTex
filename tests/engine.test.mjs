import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INDEX_PATH = path.resolve(__dirname, '..', 'index.html');

function loadEngine(extraGlobals = {}) {
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scriptMatches.length > 0, 'index.html should contain inline <script> blocks');
  const appScript = scriptMatches[scriptMatches.length - 1][1];

  const context = vm.createContext({
    console,
    Date,
    Math,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    ...extraGlobals
  });
  vm.runInContext(appScript, context, { filename: 'index.html#script' });
  assert.ok(context.__AI_LATEX_ENGINE__, 'engine exports must exist');
  return context.__AI_LATEX_ENGINE__;
}

/**
 * Lightweight strict XML structure & entity validator for HWPX output verification.
 */
function assertWellFormedXml(xmlStr, label) {
  assert.ok(!/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/.test(xmlStr), `${label}: contains illegal XML 1.0 control characters`);
  assert.ok(xmlStr.startsWith('<?xml version="1.0" encoding="UTF-8"'), `${label}: missing XML declaration`);

  const withoutDecl = xmlStr.replace(/^<\?xml[^?]*\?>\s*/, '');
  // Validate unescaped ampersands outside valid entities
  const textParts = withoutDecl.replace(/<[^>]+>/g, '\n').split('\n');
  for (const txt of textParts) {
    assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(txt), `${label}: unescaped '&' in text: ${txt}`);
  }

  const stack = [];
  const tagRe = /<(\/?)([a-zA-Z0-9_:-]+)((?:\s+[a-zA-Z0-9_:-]+="[^"]*")*)\s*(\/?)>/g;
  let lastEnd = 0;
  let match;
  while ((match = tagRe.exec(withoutDecl)) !== null) {
    const gap = withoutDecl.slice(lastEnd, match.index);
    assert.ok(!/[<>]/.test(gap), `${label}: stray angle bracket in text: ${gap}`);
    const [, isClose, tagName, , isSelfClose] = match;
    if (isClose) {
      const top = stack.pop();
      assert.equal(top, tagName, `${label}: mismatched closing tag </${tagName}> (expected </${top}>)`);
    } else if (!isSelfClose) {
      stack.push(tagName);
    }
    lastEnd = tagRe.lastIndex;
  }
  assert.equal(stack.length, 0, `${label}: unclosed XML tags remain: ${stack.join(', ')}`);
  const tail = withoutDecl.slice(lastEnd);
  assert.ok(!/[<>]/.test(tail), `${label}: trailing stray angle bracket: ${tail}`);
}

const engine = loadEngine();

test('SAMPLE_TEXT extracts equations accurately without dropping parens or negative signs', () => {
  const res = engine.processText(engine.SAMPLE_TEXT);
  const clean = res.cleanedSource;

  assert.ok(clean.includes('$-4 < t < -3$'), 'Leading unary minus in inequality must stay inside math delimiters');
  assert.ok(clean.includes('$f(n) = -n^2 + an - b + c$'), 'Full polynomial equation with spaces around +/- must stay intact');
  assert.ok(clean.includes('$g(t) = 0$ $\\implies$ $f(-|x|) = f(t)$'), 'Formula immediately after protected \\implies token must not be skipped');
  assert.ok(clean.includes('$v = 6 - t \\le 0$이므로'), 'Relation \\le on RHS must parse the full comparison v = 6 - t \\le 0');
  assert.ok(clean.includes('$t = \\alpha$ ($\\alpha > 0$)에서는') || clean.includes('$t = \\alpha$ $(\\alpha > 0)$에서는'), 'Parenthetical inequality after protected formula must be wrapped preserving parens');
  assert.ok(!res.tokenizedText.includes('\\quad'), 'Stray \\quad outside math blocks must be cleaned up');
  assert.ok(clean.includes('(또는 $2 \\to 3 \\to 2$)가 되어'), 'Unmatched outer parens around arrow chain must remain outside $...$');
  assert.ok(clean.includes('$x = 0$을 대입하면 $f(0) = f(t)$이고'), 'Inline function equality must stay balanced');
  assert.ok(clean.includes('우함수($|x|$에만 의존)'), 'Orphan trailing $ in AI response should allow |x| healing cleanly');

  // Verify HWP conversion inside SAMPLE_TEXT has no leftover LaTeX backslashes on lim/sum/int or bad scripts
  const hwpAll = res.extractedFormulas.map(f => f.hwp).join('\n');
  assert.ok(!hwpAll.includes('\\lim'), 'HWP output must not contain \\lim');
  assert.ok(!hwpAll.includes('\\sum'), 'HWP output must not contain \\sum');
  assert.ok(!hwpAll.includes('\\int'), 'HWP output must not contain \\int');
  assert.ok(hwpAll.includes('sqrt {x^{2}+1}'), 'Unbraced exponent in \\sqrt{x^2+1} must only capture ^2, not ^2+1');
  assert.ok(hwpAll.includes('bmatrix { 1 & 0 # 0 & 1 }'), 'HWP bmatrix block round-trips cleanly');
  assert.ok(hwpAll.includes('pmatrix { a & b # c & d }'), 'HWP pmatrix block round-trips cleanly');
});

test('latexToHwp handles unbraced scripts, stacked fractions, operators, braces, and nested environments', () => {
  assert.equal(engine.latexToHwp('2^n+1'), '2^{n}+1');
  assert.equal(engine.latexToHwp('x_ij'), 'x_{i} j');
  assert.equal(engine.latexToHwp('\\sqrt{x^2+1}'), 'sqrt {x^{2}+1}');
  assert.equal(engine.latexToHwp('\\lim_{x \\to 0} \\frac{\\sin x}{x}'), 'lim _{x -> 0} {sin x} over {x}');
  assert.equal(engine.latexToHwp('\\sum_{k=1}^{n} k^2'), 'sum _{k=1} ^{n} k^{2}');
  assert.equal(engine.latexToHwp('\\iint_{D} f\\,dA'), 'dint _{D} f`dA');
  assert.equal(engine.latexToHwp('\\iiint_{V} dV'), 'tint _{V} dV');
  assert.equal(engine.latexToHwp('\\frac{a}{b}^2'), '{{a} over {b}}^{2}');
  assert.equal(engine.latexToHwp('\\binom{n}{k}'), '{n} choose {k}');
  assert.equal(engine.latexToHwp('\\left\\{ x \\in A \\right\\}'), 'left lbrace x in A right rbrace');
  assert.equal(engine.latexToHwp('\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}'), 'eqalign { a & = b # c & = d }');
  assert.equal(engine.latexToHwp('\\begin{Bmatrix} 1 & 2 \\\\ 3 & 4 \\end{Bmatrix}'), 'left lbrace matrix { 1 & 2 # 3 & 4 } right rbrace');
  assert.equal(engine.latexToHwp('\\begin{Vmatrix} a & b \\\\ c & d \\end{Vmatrix}'), 'left Vert matrix { a & b # c & d } right Vert');
  assert.equal(
    engine.latexToHwp('\\begin{matrix} \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix} & 0 \\\\ 0 & 1 \\end{matrix}'),
    'matrix { pmatrix { 1 & 2 # 3 & 4 } & 0 # 0 & 1 }'
  );
  assert.equal(
    engine.latexToHwp('\\begin{matrix} A \\& B \\\\ C \\& D \\end{matrix}'),
    'matrix { A \\& B # C \\& D }'
  );
});

test('hwpToLatex handles nested braces, nested matrices, operators without spaces, and eqalign', () => {
  assert.equal(
    engine.hwpToLatex('pmatrix { {1} over {2} & 0 # 0 & 1 }'),
    '\\begin{pmatrix} \\frac{1}{2} & 0 \\\\ 0 & 1 \\end{pmatrix}'
  );
  assert.equal(
    engine.hwpToLatex('pmatrix { pmatrix { 1 # 2 } & 0 # 0 & 1 }'),
    '\\begin{pmatrix} \\begin{pmatrix} 1 \\\\ 2 \\end{pmatrix} & 0 \\\\ 0 & 1 \\end{pmatrix}'
  );
  assert.equal(
    engine.hwpToLatex('eqalign { a & b # c & d }'),
    '\\begin{aligned} a & b \\\\ c & d \\end{aligned}'
  );
  assert.equal(
    engine.hwpToLatex('a <= b => c <=> d -> e != f +- g'),
    'a \\le b \\implies c \\iff d \\to e \\neq f \\pm g'
  );
  assert.equal(
    engine.hwpToLatex('root {3} of {x^{2}+1} + sqrt {{a} over {b}}'),
    '\\sqrt[3]{x^{2}+1} + \\sqrt{\\frac{a}{b}}'
  );
});

test('processText & repairMathString protect code blocks, English words inside \\text, matrix linebreaks, and currency', () => {
  // 1. Matrix row-break \\b must NOT be collapsed into \b
  const matInput = '$$\n\\begin{matrix}\na \\\\b\n\\end{matrix}\n$$';
  const matRes = engine.processText(matInput);
  assert.ok(matRes.extractedFormulas[0].cleaned.includes('a \\\\b'), 'Matrix linebreak \\\\b must stay intact');
  assert.equal(matRes.extractedFormulas[0].hwp, 'matrix { a # b }');

  // Double-escaped known commands MUST still heal
  const dblRes = engine.processText('$\\\\frac{1}{2} + \\\\alpha$');
  assert.equal(dblRes.extractedFormulas[0].cleaned, '\\frac{1}{2} + \\alpha');

  // 2. \text{game over time} and \text{go to school} must not corrupt English words
  const textRes = engine.processText('$\\text{game over time}$ 그리고 $\\text{go to school}$');
  assert.equal(textRes.extractedFormulas[0].cleaned, '\\text{game over time}');
  assert.equal(textRes.extractedFormulas[1].cleaned, '\\text{go to school}');

  // Also plain prose "game over time" outside $...$
  const proseRes = engine.processText('This is game over time in plain prose.');
  assert.equal(proseRes.extractedFormulas.length, 0);

  // 3. Currency $500 and $600 must be preserved
  const moneyRes = engine.processText('가격은 $500과 $600입니다. 단일 금액 $1,250.50도 유지됩니다.');
  assert.equal(moneyRes.extractedFormulas.length, 0);
  assert.ok(moneyRes.cleanedSource.includes('\\$500과 \\$600'));
  assert.ok(moneyRes.cleanedSource.includes('\\$1,250.50'));

  // 4. Fenced markdown code blocks must not have math extracted or tokenized inside code fences
  const fencedRes = engine.processText('설명:\n\n```latex\n\\frac{1}{2} + \\alpha\n```\n\n본문 $x = 1$.');
  assert.equal(fencedRes.extractedFormulas.length, 1);
  assert.equal(fencedRes.extractedFormulas[0].cleaned, 'x = 1');
  assert.ok(fencedRes.cleanedSource.includes('```latex\n\\frac{1}{2} + \\alpha\n```'));
});

test('Security: DOMPurify hook, event delegation attribute, and HTML/XML escaping', () => {
  const escaped = engine.escapeHtml(`<img src="x" onerror='alert(1)'> & more`);
  assert.equal(escaped, '&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt; &amp; more');

  let domPurifyCalledWith = null;
  const mockEngine = loadEngine({
    marked: {
      setOptions() {},
      parse: (t) => `<p>${t}</p>`
    },
    DOMPurify: {
      sanitize: (html) => {
        domPurifyCalledWith = html;
        return html.replace(/<script[\s\S]*?<\/script>/gi, '');
      }
    },
    katex: {
      renderToString: (f) => `<span class="katex">${f}</span>`
    }
  });

  const xssRes = mockEngine.processText('<script>alert(1)<\/script> $x = 1$');
  assert.ok(domPurifyCalledWith !== null, 'DOMPurify.sanitize must be invoked');
  assert.ok(!xssRes.renderedHtml.includes('<script>'), 'XSS script tag must be stripped');
  assert.ok(!xssRes.renderedHtml.includes('onclick='), 'Must not include inline onclick handlers');
  assert.ok(!xssRes.renderedHtml.includes('data-copy-hwp-idx='), 'Click-to-copy attributes must not be injected');
  assert.ok(xssRes.renderedHtml.includes('<span class="katex">x = 1</span>'));
});

test('buildHwpxPackageFiles produces OWPML-compliant package files and well-formed XML', () => {
  const fixedDate = new Date('2026-05-01T12:34:56Z');
  const docText = '# 1. 테스트 제목\n가격은 $500과 $600입니다.\n$$\\begin{pmatrix} 1 & 0 \\\\ 0 & 1 \\end{pmatrix}$$\n컨트롤문자 테스트: \x01 <태그> & "인용" $y = \\frac{x+1}{x-1}$';
  const { files } = engine.buildHwpxPackageFiles(docText, fixedDate);

  // Entry keys & ordering
  const keys = Object.keys(files);
  assert.equal(keys[0], 'mimetype', 'mimetype MUST be first ZIP entry');
  assert.equal(files['mimetype'], 'application/hwp+zip');
  for (const required of [
    'version.xml',
    'META-INF/container.xml',
    'META-INF/manifest.xml',
    'META-INF/container.rdf',
    'Preview/PrvText.txt',
    'settings.xml',
    'Contents/content.hpf',
    'Contents/header.xml',
    'Contents/section0.xml'
  ]) {
    assert.ok(required in files, `Missing required HWPX entry: ${required}`);
  }

  // version.xml must use hv:HCFVersion + tagetApplication typo expected by Hancom
  assert.ok(files['version.xml'].includes('<hv:HCFVersion '), 'version.xml must use hv:HCFVersion root');
  assert.ok(files['version.xml'].includes('tagetApplication="WORDPROCESSOR"'), 'version.xml must include tagetApplication attribute');

  // container.xml media-type must be application/hwpml-package+xml
  assert.ok(files['META-INF/container.xml'].includes('full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"'));
  assert.ok(files['META-INF/container.xml'].includes('full-path="Preview/PrvText.txt" media-type="text/plain"'));
  assert.ok(files['META-INF/container.xml'].includes('full-path="META-INF/container.rdf" media-type="application/rdf+xml"'));

  // header.xml compatibility & schema elements
  const hdr = files['Contents/header.xml'];
  assert.ok(hdr.includes('<hh:underline '), 'charPr must include hh:underline');
  assert.ok(hdr.includes('<hh:strikeout '), 'charPr must include hh:strikeout');
  assert.ok(hdr.includes('<hh:outline '), 'charPr must include hh:outline');
  assert.ok(hdr.includes('<hh:shadow '), 'charPr must include hh:shadow');
  assert.ok(hdr.indexOf('<hh:bold/>') < hdr.lastIndexOf('<hh:underline '), 'hh:bold must precede hh:underline in CharShape');
  assert.ok(hdr.includes('charPrIDRef="4294967295"'), 'numbering paraHead should use 4294967295');
  assert.ok(hdr.includes('textDir="LTR"'), 'paraPr must include textDir="LTR"');
  assert.ok(hdr.includes('<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">'), 'paraPr must wrap margin/lineSpacing in hp:switch');
  assert.ok(hdr.includes('<hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument>'));
  assert.ok(hdr.includes('<hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption>'));
  assert.ok(hdr.includes('<hh:metaTag>{"name":""}</hh:metaTag>'));
  assert.ok(hdr.includes('<hh:trackchageConfig flags="56"/>'));

  // section0.xml structure & equations
  const sec = files['Contents/section0.xml'];
  assert.ok(sec.includes('<hp:pageBorderFill type="BOTH"'));
  assert.ok(sec.includes('<hp:pageBorderFill type="EVEN"'));
  assert.ok(sec.includes('<hp:pageBorderFill type="ODD"'));
  assert.ok(sec.includes('<hp:p id="0"'), 'First paragraph should use id="0"');
  assert.ok(!/<hp:run[^>]*>(?:(?!<\/hp:run>)[\s\S])*?<hp:secPr(?:(?!<\/hp:run>)[\s\S])*?<hp:equation/.test(sec), 'hp:secPr run must be separate from hp:equation runs');
  assert.ok(sec.includes('</hp:equation><hp:t/></hp:run>'), 'Equation runs must terminate with <hp:t/>');
  assert.ok(sec.includes('baseUnit="1100"'), 'Equations should use baseUnit="1100"');
  assert.ok(sec.includes('가격은 $500과 $600입니다.'), 'Unmatched currency $500 must NOT contain escaped \\$ inside HWPX <hp:t>');
  assert.ok(files['Preview/PrvText.txt'].includes('$500'), 'Preview text must preserve currency unescaped');

  // Equation sizing sanity check (no bloated charLength * 420)
  const pmatBox = engine.estimateHwpEquationBox('pmatrix { 1 & 0 # 0 & 1 }', true);
  assert.ok(pmatBox.width >= 1500 && pmatBox.width <= 3200, `Unexpected pmatrix width: ${pmatBox.width}`);
  assert.ok(pmatBox.height >= 2200 && pmatBox.height <= 2600, `Unexpected pmatrix height: ${pmatBox.height}`);
  assert.equal(pmatBox.baseLine, 66);

  // Well-formedness check across ALL XML files (both SAMPLE_TEXT and special chars input)
  for (const xmlPath of [
    'version.xml',
    'META-INF/container.xml',
    'META-INF/manifest.xml',
    'META-INF/container.rdf',
    'settings.xml',
    'Contents/content.hpf',
    'Contents/header.xml',
    'Contents/section0.xml'
  ]) {
    assertWellFormedXml(files[xmlPath], xmlPath);
  }

  // Also test full SAMPLE_TEXT HWPX generation end-to-end and first-line display equation
  const firstLineEq = engine.buildHwpxPackageFiles('$$ x = 1 $$', fixedDate);
  const firstSec = firstLineEq.files['Contents/section0.xml'];
  assertWellFormedXml(firstSec, 'First-line equation section0.xml');
  assert.ok(!/<hp:run[^>]*>(?:(?!<\/hp:run>)[\s\S])*?<hp:secPr(?:(?!<\/hp:run>)[\s\S])*?<hp:equation/.test(firstSec), 'First-line equation must still keep hp:secPr in its own initial run');

  const sampleHwpx = engine.buildHwpxPackageFiles(engine.SAMPLE_TEXT, fixedDate);
  assertWellFormedXml(sampleHwpx.files['Contents/section0.xml'], 'SAMPLE_TEXT section0.xml');
  assertWellFormedXml(sampleHwpx.files['Contents/header.xml'], 'SAMPLE_TEXT header.xml');
  assert.ok(!sampleHwpx.files['Contents/section0.xml'].includes('<hp:script></hp:script>'), 'No empty equation scripts allowed');
  assert.ok(!sampleHwpx.files['Contents/section0.xml'].includes('\\lim'), 'HWPX script must not leak raw \\lim');
  assert.ok(!sampleHwpx.files['Contents/section0.xml'].includes('\\sum'), 'HWPX script must not leak raw \\sum');
  assert.ok(!sampleHwpx.files['Contents/section0.xml'].includes('\\int'), 'HWPX script must not leak raw \\int');
});

test('HWPX template inspection and text/equation insertion support placeholders, table cells, append, and replace_body', () => {
  const nsAttrs = 'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"';
  const basePackage = engine.buildHwpxPackageFiles('템플릿 기준', new Date('2026-05-01T00:00:00Z')).files;

  const customHeader = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hh:head ${nsAttrs} version="1.4" secCnt="1"><hh:refList><hh:charProperties itemCnt="3"><hh:charPr id="0" height="1000"/><hh:charPr id="2" height="1100"/><hh:charPr id="5" height="1200"><hh:bold/></hh:charPr></hh:charProperties><hh:paraProperties itemCnt="2"><hh:paraPr id="0"><hh:align horizontal="LEFT"/></hh:paraPr><hh:paraPr id="3"><hh:align horizontal="CENTER"/></hh:paraPr></hh:paraProperties><hh:styles itemCnt="2"><hh:style id="0" paraPrIDRef="0" charPrIDRef="0"/><hh:style id="1" paraPrIDRef="0" charPrIDRef="2"/></hh:styles></hh:refList></hh:head>`;

  const customSection = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec ${nsAttrs}>` +
    `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">` +
      `<hp:run charPrIDRef="0"><hp:secPr id="" textDirection="HORIZONTAL"><hp:pagePr width="59528" height="84186"/></hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/><hp:header id="1" applyPageType="BOTH"><hp:subList><hp:p id="999" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>학교 시험지 머리글</hp:t></hp:run></hp:p></hp:subList></hp:header></hp:ctrl><hp:t/></hp:run>` +
      `<hp:run charPrIDRef="5"><hp:t>1. 시험지 제목</hp:t></hp:run>` +
    `</hp:p>` +
    `<hp:p id="10" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">` +
      `<hp:run charPrIDRef="0"><hp:tbl id="50" rowCnt="1" colCnt="2"><hp:tr>` +
        `<hp:tc><hp:cellSz width="15000" height="3000"/><hp:subList><hp:p id="11" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>문제 설명</hp:t></hp:run></hp:p></hp:subList></hp:tc>` +
        `<hp:tc><hp:cellSz width="20000" height="3000"/><hp:subList><hp:p id="12" paraPrIDRef="0" styleIDRef="1"><hp:run charPrIDRef="2"><hp:t>정답: {{</hp:t></hp:run><hp:run charPrIDRef="2"><hp:t>본문}} 끝</hp:t></hp:run><hp:linesegarray><hp:lineseg textpos="0"/></hp:linesegarray></hp:p></hp:subList></hp:tc>` +
      `</hp:tr></hp:tbl><hp:t/></hp:run>` +
    `</hp:p>` +
    `<hp:p id="20" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>참고 사항</hp:t></hp:run></hp:p>` +
  `</hs:sec>`;

  const templateFiles = {
    ...basePackage,
    'Contents/header.xml': customHeader,
    'Contents/section0.xml': customSection
  };

  // 1. Header style & section slot inspection
  const styles = engine.inspectHwpxHeaderStyles(customHeader);
  assert.equal(styles.boldCharPrId, '5');
  assert.equal(styles.centerParaPrId, '3');

  const inspected = engine.inspectHwpxSectionSlots(customSection);
  assert.ok(!inspected.slots.some(s => s.rawText.includes('학교 시험지 머리글')), 'Header paragraphs must NOT appear as body slots');
  assert.equal(inspected.slots.length, 5);
  assert.equal(inspected.slots[0].locationLabel, '본문 문단 1');
  assert.equal(inspected.slots[0].hasSecPr, true);
  assert.equal(inspected.slots[1].hasTableChild, true);
  assert.equal(inspected.slots[2].locationLabel, '표1 · 1행 1열');
  assert.equal(inspected.slots[3].locationLabel, '표1 · 1행 2열');
  assert.equal(inspected.slots[3].maxContentWidth, 19200);
  assert.equal(inspected.slots[3].placeholders[0].full, '{{본문}}');
  assert.equal(inspected.recommendedSlotId, 3);
  assert.equal(inspected.recommendedMode, 'replace');

  // 2. Replace inline split placeholder inside table cell (multi-line + equation)
  const replacedCell = engine.applyTextToHwpxTemplateFiles(templateFiles, '첫째 줄 $x = \\frac{1}{2}$\n둘째 줄');
  const repSec = replacedCell.files['Contents/section0.xml'];
  assertWellFormedXml(repSec, 'Template replace inline cell section0.xml');
  assert.ok(!repSec.includes('{{'), 'Placeholder must be fully replaced');
  assert.ok(repSec.includes('정답: '), 'Inline prefix before {{본문}} must be preserved');
  assert.ok(repSec.includes(' 끝'), 'Inline suffix after {{본문}} must be preserved');
  assert.ok(repSec.includes('학교 시험지 머리글'), 'Template header must remain intact');
  assert.ok(repSec.includes('문제 설명'), 'Sibling table cell must remain intact');
  assert.ok(repSec.includes('<hp:script>{1} over {2}</hp:script>') || repSec.includes('{1} over {2}'), 'Inserted equation must convert to HWP EqEdit');
  assert.ok(!repSec.includes('<hp:linesegarray>'), 'Stale linesegarray on replaced cell paragraph must be stripped');

  // 3. Append after heading paragraph
  const appended = engine.applyTextToHwpxTemplateFiles(templateFiles, '추가 본문 $y = x^2$', {
    slotId: 0,
    mode: 'after'
  });
  const appSec = appended.files['Contents/section0.xml'];
  assertWellFormedXml(appSec, 'Template append section0.xml');
  assert.ok(appSec.includes('1. 시험지 제목'), 'Original selected paragraph must remain');
  assert.ok(appSec.indexOf('1. 시험지 제목') < appSec.indexOf('추가 본문'), 'Appended paragraph must follow selected slot');
  assert.ok(appSec.indexOf('추가 본문') < appSec.indexOf('문제 설명'), 'Appended paragraph must precede following table paragraph');

  // 4. replace_body preserves secPr + header while replacing old body & tables
  const replacedBody = engine.applyTextToHwpxTemplateFiles(templateFiles, '# 새 제목\n$$a^2 + b^2 = c^2$$', {
    mode: 'replace_body'
  });
  const bodySec = replacedBody.files['Contents/section0.xml'];
  assertWellFormedXml(bodySec, 'Template replace_body section0.xml');
  assert.ok(bodySec.includes('<hp:secPr '), 'secPr must survive replace_body');
  assert.ok(bodySec.includes('학교 시험지 머리글'), 'Header inside ctrl must survive replace_body');
  assert.ok(!bodySec.includes('문제 설명'), 'Old template table must be wiped in replace_body');
  assert.ok(!bodySec.includes('참고 사항'), 'Old template body must be wiped in replace_body');
  assert.ok(bodySec.includes('charPrIDRef="5"'), 'Heading should resolve template bold charPr ID 5');
  assert.ok(bodySec.includes('paraPrIDRef="3"'), 'Display equation should resolve template center paraPr ID 3');

  // 5. Fallback when template header.xml only has charPr id="0" and paraPr id="0"
  const minimalHeader = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hh:head ${nsAttrs}><hh:refList><hh:charProperties itemCnt="1"><hh:charPr id="0" height="1000"/></hh:charProperties><hh:paraProperties itemCnt="1"><hh:paraPr id="0"><hh:align horizontal="LEFT"/></hh:paraPr></hh:paraProperties><hh:styles itemCnt="1"><hh:style id="0" paraPrIDRef="0" charPrIDRef="0"/></hh:styles></hh:refList></hh:head>`;
  const minimalRes = engine.applyTextToHwpxTemplateFiles({
    ...templateFiles,
    'Contents/header.xml': minimalHeader
  }, '# 제목\n$$z = 1$$', { mode: 'replace_body' });
  const minSec = minimalRes.files['Contents/section0.xml'];
  assertWellFormedXml(minSec, 'Minimal header fallback section0.xml');
  assert.ok(!minSec.includes('charPrIDRef="1"'), 'Must not reference nonexistent charPr 1');
  assert.ok(!minSec.includes('paraPrIDRef="1"'), 'Must not reference nonexistent paraPr 1');
});

test('buildSampleWorksheetTemplateFiles creates a valid sample HWPX template with bordered table and {{본문}} slot', () => {
  const sampleFiles = engine.buildSampleWorksheetTemplateFiles(new Date('2026-05-01T00:00:00Z'));
  assertWellFormedXml(sampleFiles['Contents/header.xml'], 'Sample worksheet header.xml');
  assertWellFormedXml(sampleFiles['Contents/section0.xml'], 'Sample worksheet section0.xml');
  assertWellFormedXml(sampleFiles['Contents/content.hpf'], 'Sample worksheet content.hpf');
  assert.ok(sampleFiles['Contents/header.xml'].includes('<hh:borderFills itemCnt="4">'));

  const inspected = engine.inspectHwpxSectionSlots(sampleFiles['Contents/section0.xml']);
  assert.ok(inspected.slots.some(s => s.locationLabel === '표1 · 2행 1열' && s.placeholders[0]?.full === '{{본문}}'));
  const target = inspected.slots.find(s => s.slotId === inspected.recommendedSlotId);
  assert.equal(target.locationLabel, '표1 · 2행 1열');
  assert.equal(inspected.recommendedMode, 'replace');

  const merged = engine.applyTextToHwpxTemplateFiles(sampleFiles, engine.SAMPLE_TEXT);
  assertWellFormedXml(merged.files['Contents/section0.xml'], 'Merged sample worksheet section0.xml');
  assert.ok(!merged.files['Contents/section0.xml'].includes('{{본문}}'));
  assert.ok(merged.files['Contents/section0.xml'].includes('수학 풀이 정리 양식'));
  assert.ok(merged.files['Contents/section0.xml'].includes('과목 / 단원:'));
  assert.ok(merged.files['Contents/section0.xml'].includes('<hp:script>'));
});

test('renderHwpxTemplatePreviewHtml renders worksheet tables, borders, shading, and live body into preview/print HTML safely', () => {
  const sampleFiles = engine.buildSampleWorksheetTemplateFiles(new Date('2026-05-01T00:00:00Z'));
  const bodyHtml = '<p>변환된 수식 <strong>테스트</strong></p>';

  // 1. Default replace mode puts bodyHtml into the {{본문}} table cell cleanly
  const previewReplace = engine.renderHwpxTemplatePreviewHtml(sampleFiles, bodyHtml);
  assert.ok(previewReplace.includes('class="hwpx-preview-sheet"'));
  assert.ok(previewReplace.includes('<table class="hwpx-preview-table"'));
  assert.ok(previewReplace.includes('수학 풀이 정리 양식'));
  assert.ok(previewReplace.includes('과목 / 단원:'));
  assert.ok(previewReplace.includes('background-color:#EFF6FF;'), 'Header row borderFill shading must render');
  assert.ok(previewReplace.includes('colspan="2"'), 'Merged body cell must keep colspan="2"');
  assert.ok(!previewReplace.includes('{{본문}}'), '{{본문}} placeholder should be replaced by rendered bodyHtml');
  assert.ok(previewReplace.includes(bodyHtml));

  // 2. Append mode keeps original slot and appends rendered bodyHtml after it
  const inspected = engine.inspectHwpxSectionSlots(sampleFiles['Contents/section0.xml']);
  const previewAfter = engine.renderHwpxTemplatePreviewHtml(sampleFiles, bodyHtml, { slotId: 0, mode: 'after' });
  assert.ok(previewAfter.includes('수학 풀이 정리 양식'));
  assert.ok(previewAfter.indexOf('수학 풀이 정리 양식') < previewAfter.indexOf(bodyHtml));
  assert.ok(previewAfter.indexOf(bodyHtml) < previewAfter.indexOf('과목 / 단원:'));

  // 3. replace_body shows sheet wrapper without old table
  const previewBodyOnly = engine.renderHwpxTemplatePreviewHtml(sampleFiles, bodyHtml, { mode: 'replace_body' });
  assert.ok(previewBodyOnly.includes('data-template-mode="replace_body"'));
  assert.ok(!previewBodyOnly.includes('<table class="hwpx-preview-table"'));
  assert.ok(previewBodyOnly.includes(bodyHtml));

  // 4. XSS safety: HTML chars in template text & rogue tags in XML must never render as active HTML
  const maliciousXml = sampleFiles['Contents/section0.xml']
    .replace('검산 및 추가 메모:', '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;메모<script>alert(2)</script>');
  const safePreview = engine.renderHwpxTemplatePreviewHtml(
    { ...sampleFiles, 'Contents/section0.xml': maliciousXml },
    bodyHtml
  );
  assert.ok(!safePreview.includes('<img src=x'));
  assert.ok(!safePreview.includes('<script>'));
  assert.ok(safePreview.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;메모'));
  assert.ok(inspected.slots.length > 0);
});

test('applyEditsToHwpxTemplateFiles and multi-slot renderHwpxTemplatePreviewHtml handle simultaneous cell edits', () => {
  const sampleFiles = engine.buildSampleWorksheetTemplateFiles(new Date('2026-05-01T00:00:00Z'));
  const inspected = engine.inspectHwpxSectionSlots(sampleFiles['Contents/section0.xml']);
  const subjectSlot = inspected.slots.find(s => s.locationLabel === '표1 · 1행 1열');
  const nameSlot = inspected.slots.find(s => s.locationLabel === '표1 · 1행 2열');
  const bodySlot = inspected.slots.find(s => s.locationLabel === '표1 · 2행 1열');
  assert.ok(subjectSlot && nameSlot && bodySlot);

  // 1. Multi-slot preview HTML annotates clickable slots and renders all edited cells together
  const previewHtml = engine.renderHwpxTemplatePreviewHtml(sampleFiles, {
    sectionPath: 'Contents/section0.xml',
    activeSlotId: nameSlot.slotId,
    activeMode: 'replace',
    edits: [
      { sectionPath: 'Contents/section0.xml', slotId: subjectSlot.slotId, mode: 'replace', renderedHtml: '과목 / 단원: 미적분 I' },
      { sectionPath: 'Contents/section0.xml', slotId: nameSlot.slotId, mode: 'replace', renderedHtml: '이름 / 날짜: 홍길동' },
      { sectionPath: 'Contents/section0.xml', slotId: bodySlot.slotId, mode: 'replace', renderedHtml: '풀이: x² + y² = r²' }
    ]
  });
  assert.ok(previewHtml.includes(`data-cell-slot-uid="Contents/section0.xml::${subjectSlot.slotId}"`));
  assert.ok(previewHtml.includes(`data-cell-slot-uid="Contents/section0.xml::${nameSlot.slotId}"`));
  assert.ok(previewHtml.includes('hwpx-slot-clickable'));
  assert.ok(previewHtml.includes('hwpx-slot-selected'));
  assert.ok(previewHtml.includes('과목 / 단원: 미적분 I'));
  assert.ok(previewHtml.includes('이름 / 날짜: 홍길동'));
  assert.ok(previewHtml.includes('풀이: x² + y² = r²'));
  assert.ok(previewHtml.includes('검산 및 추가 메모:'));

  // 2. Multi-slot HWPX export splices all edited slots cleanly in one well-formed section0.xml
  const merged = engine.applyEditsToHwpxTemplateFiles(sampleFiles, [
    { sectionPath: 'Contents/section0.xml', slotId: subjectSlot.slotId, mode: 'replace', rawText: '과목 / 단원: 미적분 I' },
    { sectionPath: 'Contents/section0.xml', slotId: nameSlot.slotId, mode: 'replace', rawText: '이름 / 날짜: 홍길동' },
    { sectionPath: 'Contents/section0.xml', slotId: bodySlot.slotId, mode: 'replace', rawText: '핵심 공식 $x^2 + y^2 = r^2$' }
  ]);
  const secXml = merged.files['Contents/section0.xml'];
  assertWellFormedXml(secXml, 'Multi-slot edited section0.xml');
  assert.ok(secXml.includes('과목 / 단원: 미적분 I'));
  assert.ok(secXml.includes('이름 / 날짜: 홍길동'));
  assert.ok(secXml.includes('핵심 공식 '));
  assert.ok(secXml.includes('<hp:script>'));
  assert.ok(!secXml.includes('{{본문}}'));
  assert.ok(secXml.includes('검산 및 추가 메모:'));
});

test('hwpToLatex handles uppercase keywords, prime, vert, Korean text, and latexToHwp \\sim', () => {
  assert.equal(
    engine.hwpToLatex('f prime  (x)=0.2x ^{2} -0.65x+1.91'),
    "f' (x)=0.2x ^{2} -0.65x+1.91"
  );
  assert.equal(engine.hwpToLatex('(A SIM  E)'), '(A \\sim E)');
  assert.equal(
    engine.hwpToLatex('vert 실제값-f(x) vert  APPROX  0.08361'),
    '\\vert \\text{실제값}-f(x) \\vert \\approx 0.08361'
  );
  assert.equal(
    engine.hwpToLatex('{a} OVER {b} TIMES SQRT {x} -> INF'),
    '\\frac{a}{b} \\times \\sqrt{x} \\to \\infty'
  );
  assert.equal(engine.latexToHwp('A \\sim E'), 'A sim E');
});

test('renderHwpxTemplatePreviewHtml renders inline photos, BEHIND_TEXT form layers, and preserves pictures/equations on inspect', () => {
  const nsAttrs = 'xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:opf="http://www.idpf.org/2007/opf/"';
  const tinyPng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
  const tinyJpg = new Uint8Array([255, 216, 255, 224, 0, 16, 74, 70]);
  const tinyWmf = new Uint8Array([1, 0, 9, 0]);

  const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hh:head ${nsAttrs}><hh:refList><hh:charProperties itemCnt="1"><hh:charPr id="0" height="1000"/></hh:charProperties><hh:paraProperties itemCnt="1"><hh:paraPr id="0"><hh:align horizontal="LEFT"/></hh:paraPr></hh:paraProperties><hh:borderFills itemCnt="1"><hh:borderFill id="3"><hh:leftBorder type="SOLID" color="#64748B"/><hh:rightBorder type="SOLID" color="#64748B"/><hh:topBorder type="SOLID" color="#64748B"/><hh:bottomBorder type="SOLID" color="#64748B"/></hh:borderFill></hh:borderFills><hh:styles itemCnt="1"><hh:style id="0" paraPrIDRef="0" charPrIDRef="0"/></hh:styles></hh:refList></hh:head>`;
  const hpfXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><opf:package ${nsAttrs}><opf:manifest><opf:item id="bg1" href="BinData/bg1.png" media-type="image/png"/><opf:item id="pic1" href="BinData/photo.jpg" media-type="image/jpg"/><opf:item id="vec1" href="BinData/legacy.wmf" media-type="image/wmf"/></opf:manifest></opf:package>`;
  const picBg = (id, z) => `<hp:pic id="${id}" zOrder="${z}" textWrap="BEHIND_TEXT"><hp:orgSz width="59527" height="84188"/><hp:curSz width="0" height="0"/><hc:img binaryItemIDRef="bg1"/><hp:sz width="59527" height="84188"/><hp:pos treatAsChar="0" vertRelTo="PAGE" horzRelTo="PAGE" vertOffset="0" horzOffset="0"/></hp:pic>`;
  const picCell = `<hp:pic id="200" zOrder="5" textWrap="SQUARE"><hp:orgSz width="40000" height="20000"/><hp:curSz width="20000" height="10000"/><hc:img binaryItemIDRef="pic1"/><hp:sz width="20000" height="10000"/><hp:pos treatAsChar="0" vertRelTo="PARA" horzRelTo="PARA" vertOffset="0" horzOffset="0"/></hp:pic>`;
  const picWmf = `<hp:pic id="201" zOrder="6" textWrap="SQUARE"><hp:orgSz width="10000" height="5000"/><hp:curSz width="0" height="0"/><hc:img binaryItemIDRef="vec1"/><hp:sz width="10000" height="5000"/><hp:pos treatAsChar="1" vertRelTo="PARA" horzRelTo="PARA" vertOffset="0" horzOffset="0"/></hp:pic>`;
  const secXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec ${nsAttrs}><hp:p id="1" paraPrIDRef="0" pageBreak="0"><hp:run charPrIDRef="0"><hp:secPr><hp:pagePr width="59527" height="84188"/></hp:secPr>${picBg(100, 1)}${picBg(101, 2)}<hp:t>머리 제목</hp:t></hp:run></hp:p><hp:p id="2" paraPrIDRef="0" pageBreak="0"><hp:run charPrIDRef="0"><hp:tbl><hp:tr><hp:tc borderFillIDRef="3"><hp:subList><hp:p id="3" paraPrIDRef="0"><hp:run charPrIDRef="0">${picCell}</hp:run></hp:p></hp:subList><hp:cellSz width="40000" height="10000"/></hp:tc><hp:tc borderFillIDRef="3"><hp:subList><hp:p id="4" paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>값: </hp:t><hp:equation><hp:script>vert x vert APPROX 2</hp:script></hp:equation></hp:run></hp:p></hp:subList><hp:cellSz width="20000" height="10000"/></hp:tc></hp:tr></hp:tbl></hp:run></hp:p><hp:p id="5" paraPrIDRef="0" pageBreak="1"><hp:run charPrIDRef="0">${picWmf}<hp:t>다음 페이지</hp:t></hp:run></hp:p></hs:sec>`;

  const files = {
    'Contents/header.xml': headerXml,
    'Contents/content.hpf': hpfXml,
    'Contents/section0.xml': secXml
  };
  const binaryFiles = {
    'BinData/bg1.png': tinyPng,
    'BinData/photo.jpg': tinyJpg,
    'BinData/legacy.wmf': tinyWmf
  };

  // 1. Inspect extracts equations cleanly and tracks hasPicChild
  const inspected = engine.inspectHwpxSectionSlots(secXml);
  const eqSlot = inspected.slots.find(s => s.equationCount > 0);
  assert.ok(eqSlot);
  assert.equal(eqSlot.editorText, '값: $\\vert x \\vert \\approx 2$');
  const bgSlot = inspected.slots.find(s => s.slotId === 0);
  assert.equal(bgSlot.hasPicChild, true);

  // 2. Preview renders multi-page form layers (deduplicated per page) + photo img + WMF fallback
  const html = engine.renderHwpxTemplatePreviewHtml(files, {
    edits: [],
    binaryFiles,
    activeSlotId: eqSlot.slotId,
    activeMode: 'replace'
  });
  assert.equal((html.match(/class="hwpx-preview-page/g) || []).length, 2);
  assert.equal((html.match(/class="hwpx-page-bg-img"/g) || []).length, 1, 'Overlapping identical page backgrounds must be deduplicated');
  assert.ok(html.includes('data:image/png;base64,'), 'Page background PNG should resolve via content.hpf');
  assert.ok(html.includes('class="hwpx-pic-img" src="data:image/jpeg;base64,'), 'Table cell photo should normalize image/jpg to image/jpeg');
  assert.ok(html.includes('hwpx-pic-unsupported') && html.includes('WMF'), 'Legacy WMF should render clean fallback notice');

  // 3. Replacing text inside slot 0 preserves its attached <hp:pic> and <hp:secPr>
  const patched = engine.applyEditsToHwpxTemplateFiles(files, [
    { sectionPath: 'Contents/section0.xml', slotId: 0, mode: 'replace', rawText: '바뀐 제목' }
  ]);
  assertWellFormedXml(patched.files['Contents/section0.xml'], 'Patched pic-preserving section0.xml');
  assert.ok(patched.files['Contents/section0.xml'].includes('binaryItemIDRef="bg1"'));
  assert.ok(patched.files['Contents/section0.xml'].includes('바뀐 제목'));
});

test('Korean math shorthand recognition translates fractions, roots, powers, sums, limits without breaking currency', () => {
  const f1 = engine.processText('$2 분의 1 + 루트(x+1) = 알파$').extractedFormulas[0];
  assert.equal(f1.cleaned, '\\frac{1}{2} + \\sqrt{x+1} = \\alpha');
  assert.equal(f1.hwp, '{1} over {2} + sqrt {x+1} = alpha');

  const f2 = engine.processText('$x의 제곱 + y의 세제곱 \\ge 0$').extractedFormulas[0];
  assert.equal(f2.cleaned, 'x^{2} + y^{3} \\ge 0');

  const f3 = engine.processText('$$시그마 k=1에서 n까지 k의 제곱$$').extractedFormulas[0];
  assert.equal(f3.cleaned, '\\sum_{k=1}^{n} k^{2}');

  const f4 = engine.processText('$$리미트 x가 무한대로 갈 때 x 분의 1 = 0$$').extractedFormulas[0];
  assert.equal(f4.cleaned, '\\lim_{x \\to \\infty} \\frac{1}{x} = 0');

  const f5 = engine.processText('| A | $리미트 x가 무한대로 갈 때 x 분의 1 = 0$ |').extractedFormulas[0];
  assert.equal(f5.cleaned, '\\lim_{x \\to \\infty} \\frac{1}{x} = 0');

  const f6 = engine.processText('값은 $인테그랄 0에서 1까지 x의 제곱 dx$ 이다.').extractedFormulas[0];
  assert.equal(f6.cleaned, '\\int_{0}^{1} x^{2} dx');

  const cur = engine.processText('가격은 $500과 $600입니다.');
  assert.equal(cur.extractedFormulas.length, 0);
  assert.ok(cur.cleanedSource.includes('\\$500과 \\$600'));
});

test('Markdown tables convert to OWPML <hp:tbl> and preview reflects table widths, drawText, footer, textColor, edited badge, and multi-section', () => {
  // 1. Standalone Markdown table -> OWPML <hp:tbl>
  const mdInput = '# 분석표\n\n| 연도 | 식 |\n| :---: | --- |\n| 2025 | $2 분의 1$ |';
  const pkg = engine.buildHwpxPackageFiles(mdInput, new Date('2026-05-01T00:00:00Z'));
  const sec0 = pkg.files['Contents/section0.xml'];
  assertWellFormedXml(pkg.files['Contents/header.xml'], 'Header XML with 4 borderFills');
  assertWellFormedXml(sec0, 'Section XML with Markdown table');
  assert.ok(sec0.includes('<hp:tbl '), 'Markdown table must compile to OWPML <hp:tbl>');
  assert.ok(sec0.includes('<hp:tc '), 'OWPML table must include <hp:tc> cells');
  assert.ok(sec0.includes('2025') && sec0.includes('{1} over {2}'), 'Cell text and Korean-math equation must compile cleanly');

  // 2. Template preview fidelity 1 & 2 (width, align, drawText, footer, textColor, edited highlight, multi-section)
  const nsAttrs = 'xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"';
  const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hh:head ${nsAttrs}><hh:refList><hh:charProperties itemCnt="2"><hh:charPr id="0" height="1000" textColor="#000000"/><hh:charPr id="1" height="1000" textColor="#1D4ED8"/></hh:charProperties><hh:paraProperties itemCnt="1"><hh:paraPr id="0"><hh:align horizontal="LEFT"/></hh:paraPr></hh:paraProperties><hh:borderFills itemCnt="1"><hh:borderFill id="3"><hh:leftBorder type="SOLID" color="#64748B"/><hh:rightBorder type="SOLID" color="#64748B"/><hh:topBorder type="SOLID" color="#64748B"/><hh:bottomBorder type="SOLID" color="#64748B"/></hh:borderFill></hh:borderFills><hh:styles itemCnt="1"><hh:style id="0" paraPrIDRef="0" charPrIDRef="0"/></hh:styles></hh:refList></hh:head>`;
  const s0Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec ${nsAttrs}><hp:p id="1" paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:secPr><hp:pagePr width="59527" height="84188"/></hp:secPr><hp:ctrl><hp:footer><hp:subList><hp:p><hp:run><hp:t>쪽 바닥글</hp:t></hp:run></hp:p></hp:subList></hp:footer></hp:ctrl><hp:t>첫 구역 본문</hp:t></hp:run></hp:p><hp:p id="2" paraPrIDRef="0"><hp:run charPrIDRef="1"><hp:t>파란 강조</hp:t></hp:run></hp:p><hp:p id="3" paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:drawText><hp:subList><hp:p id="4" paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>도형 글상자</hp:t></hp:run></hp:p></hp:subList></hp:drawText></hp:run></hp:p><hp:p id="5" paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:tbl borderFillIDRef="3"><hp:sz width="20000" height="3000"/><hp:pos horzAlign="RIGHT" horzOffset="0"/><hp:tr><hp:tc borderFillIDRef="3"><hp:subList><hp:p id="6" paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>작은표</hp:t></hp:run></hp:p></hp:subList><hp:cellSz width="20000" height="3000"/></hp:tc></hp:tr></hp:tbl></hp:run></hp:p></hs:sec>`;
  const s1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec ${nsAttrs}><hp:p id="10" paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>둘째 구역</hp:t></hp:run></hp:p></hs:sec>`;

  const multiPreview = engine.renderHwpxTemplatePreviewHtml(
    { 'Contents/header.xml': headerXml, 'Contents/section0.xml': s0Xml, 'Contents/section1.xml': s1Xml },
    {
      sectionPath: 'Contents/section0.xml',
      renderAllSections: true,
      activeSlotId: 1,
      activeMode: 'replace',
      edits: [{ sectionPath: 'Contents/section0.xml', slotId: 0, mode: 'replace', renderedHtml: '수정된 첫 문단' }]
    }
  );
  assert.ok(multiPreview.includes('hwpx-slot-edited') && multiPreview.includes('data-slot-edited="true"'));
  assert.ok(multiPreview.includes('color:#1D4ED8'), 'Custom run textColor must render');
  assert.ok(multiPreview.includes('hwpx-preview-drawbox') && multiPreview.includes('도형 글상자'));
  assert.ok(multiPreview.includes('hwpx-preview-footer-note') && multiPreview.includes('쪽 바닥글'));
  assert.ok(multiPreview.includes('hwpx-section-divider') && multiPreview.includes('둘째 구역'));
  assert.ok(/hwpx-preview-table" style="width:\d+%;.*margin-left:auto/.test(multiPreview), 'Narrow right-aligned table must retain width% and margin alignment');
});

test('Round-trip integration: build/template export -> re-inspect slots & re-render preserves tables, Korean math, and edits', () => {
  // 1. Standalone export -> re-inspect & re-render round-trip
  const source = '# 보고서\n\n계산식 $2 분의 1 + x의 제곱$\n\n| 구분 | 결과 |\n| --- | --- |\n| 1차 | $알파 = 3$ |';
  const built = engine.buildHwpxPackageFiles(source, new Date('2026-05-01T00:00:00Z'));
  const reInspected = engine.inspectHwpxSectionSlots(built.files['Contents/section0.xml']);
  assert.ok(reInspected.slots.some(s => s.inTable && s.rawText.includes('구분')), 'Exported Markdown table must parse back as table slots');
  assert.ok(reInspected.slots.some(s => s.equationCount > 0 && s.editorText.includes('\\frac{1}{2}')), 'Exported equations must round-trip cleanly');
  const reRendered = engine.renderHwpxTemplatePreviewHtml(built.files, { edits: [] });
  assert.ok(reRendered.includes('hwpx-preview-table') && reRendered.includes('구분') && reRendered.includes('1차'));

  // 2. Sample worksheet multi-slot export (Markdown table + Korean math) -> re-inspect & re-render round-trip
  const sampleFiles = engine.buildSampleWorksheetTemplateFiles(new Date('2026-05-01T00:00:00Z'));
  const sampleInspected = engine.inspectHwpxSectionSlots(sampleFiles['Contents/section0.xml']);
  const subj = sampleInspected.slots.find(s => s.locationLabel === '표1 · 1행 1열');
  const body = sampleInspected.slots.find(s => s.locationLabel === '표1 · 2행 1열');
  const exported = engine.applyEditsToHwpxTemplateFiles(sampleFiles, [
    { sectionPath: 'Contents/section0.xml', slotId: subj.slotId, mode: 'replace', rawText: '과목: 미적분' },
    { sectionPath: 'Contents/section0.xml', slotId: body.slotId, mode: 'replace', rawText: '| x | y |\n| --- | --- |\n| 1 | $2 분의 1$ |' }
  ]);
  assertWellFormedXml(exported.files['Contents/section0.xml'], 'Round-trip template export section0.xml');

  const rtSlots = engine.inspectHwpxSectionSlots(exported.files['Contents/section0.xml']);
  assert.ok(rtSlots.slots.some(s => s.rawText.includes('과목: 미적분')));
  assert.ok(rtSlots.slots.some(s => s.equationCount > 0 && s.editorText.includes('\\frac{1}{2}')));
  const rtHtml = engine.renderHwpxTemplatePreviewHtml(exported.files, { edits: [] });
  assert.ok(rtHtml.includes('과목: 미적분') && rtHtml.includes('{1} over {2}'));
});

test('Korean calculus extensions (abs, Greek/fraction bounds, derivatives, logs, trig, vectors) and matrix math convert cleanly', () => {
  // 1. Absolute value + integral bounds (fractions & Greek letters) + trig
  const fAbs = engine.processText('넓이 $S = 적분 0에서 4까지 절댓값(f(x)) dx$').extractedFormulas[0];
  assert.equal(fAbs.cleaned, 'S = \\int_{0}^{4} |f(x)| dx');

  const fFracBound = engine.processText('$적분 0에서 2분의 파이까지 사인 x dx$').extractedFormulas[0];
  assert.equal(fFracBound.cleaned, '\\int_{0}^{\\frac{\\pi}{2}} \\sin x dx');

  const fGreekBound = engine.processText('$적분 알파에서 베타까지 x의 제곱 dx$').extractedFormulas[0];
  assert.equal(fGreekBound.cleaned, '\\int_{\\alpha}^{\\beta} x^{2} dx');

  const fLimFrac = engine.processText('$리미트 x가 파이로 갈 때 코사인 x$').extractedFormulas[0];
  assert.equal(fLimFrac.cleaned, '\\lim_{x \\to \\pi} \\cos x');

  // 2. Derivatives, logs, combinations, vectors
  const fDeriv = engine.processText('$dx 분의 d(x의 세제곱 + 1) = 3x의 제곱$').extractedFormulas[0];
  assert.equal(fDeriv.cleaned, '\\frac{d}{dx}(x^{3} + 1) = 3x^{2}');

  const fLog = engine.processText('$밑이 2인 로그 x + 자연로그 x = 로그 10$').extractedFormulas[0];
  assert.equal(fLog.cleaned, '\\log_{2} x + \\ln x = \\log 10');

  const fCombVec = engine.processText('$n 콤비네이션 r + 벡터 AB$').extractedFormulas[0];
  assert.equal(fCombVec.cleaned, '\\binom{n}{r} + \\overrightarrow{AB}');

  // 3. Matrix shorthand (explicit, inline with Korean math inside, bare block, cases, determinant, vdots/ddots)
  const fMat = engine.processText('$$행렬 [1, 2; 3, 4]$$').extractedFormulas[0];
  assert.equal(fMat.cleaned, '\\begin{bmatrix} 1 & 2 \\\\ 3 & 4 \\end{bmatrix}');
  assert.equal(fMat.hwp, 'bmatrix { 1 & 2 # 3 & 4 }');

  const fMatInnerKo = engine.processText('$소괄호행렬 [2분의 1, 알파; 0, 1]$').extractedFormulas[0];
  assert.equal(fMatInnerKo.cleaned, '\\begin{pmatrix} \\frac{1}{2} & \\alpha \\\\ 0 & 1 \\end{pmatrix}');

  const fDet = engine.processText('$$행렬식 [a, b; c, d]$$').extractedFormulas[0];
  assert.equal(fDet.cleaned, '\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}');
  assert.equal(fDet.hwp, 'dmatrix { a & b # c & d }');

  const fCases = engine.processText('$$연립 {x + y = 3; x - y = 1}$$').extractedFormulas[0];
  assert.equal(fCases.cleaned, '\\begin{cases} x + y = 3 \\\\ x - y = 1 \\end{cases}');

  const bareMat = engine.processText('A = 행렬 [1, 0; 0, 1]').extractedFormulas[0];
  assert.equal(bareMat.cleaned, 'A = \\begin{bmatrix} 1 & 0 \\\\ 0 & 1 \\end{bmatrix}');

  const hwpDots = engine.latexToHwp('\\begin{bmatrix} a & \\cdots & b \\\\ \\vdots & \\ddots & \\vdots \\\\ c & \\cdots & d \\end{bmatrix}');
  assert.ok(hwpDots.includes('cdots') && hwpDots.includes('vdots') && hwpDots.includes('ddots'));
  assert.equal(engine.hwpToLatex(hwpDots), '\\begin{bmatrix} a & \\cdots & b \\\\ \\vdots & \\ddots & \\vdots \\\\ c & \\cdots & d \\end{bmatrix}');

  // Still protects currency & prose
  const curCheck = engine.processText('합계는 $500과 $1,200입니다.');
  assert.equal(curCheck.extractedFormulas.length, 0);
});

test('User image attachments render safely and round-trip into OWPML <hp:pic>, BinData, and content.hpf alongside rich Markdown', () => {
  const sampleB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const attachments = new Map([
    ['att_1', { id: 'att_1', name: 'chart.png', mime: 'image/png', ext: 'png', base64: sampleB64, widthPx: 1200, heightPx: 600 }],
    ['bad_svg', { id: 'bad_svg', name: 'bad.svg', mime: 'image/svg+xml', ext: 'svg', base64: 'PHN2Zz48L3N2Zz4=', widthPx: 100, heightPx: 100 }]
  ]);

  const md = '# 실험 결과\n\n- **핵심**: *기울임* 및 `code` 와 [참고](https://example.com)\n  * 하위 항목\n> 인용 메모\n---\n![그래프](hwpx-img://att_1)\n![차단](hwpx-img://bad_svg)';
  const res = engine.processText(md, { attachments });
  assert.ok(res.renderedHtml.includes('<figure class="hwpx-attached-pic"') && res.renderedHtml.includes('data:image/png;base64,'), 'Valid attachment should render safely');
  assert.ok(res.renderedHtml.includes('첨부 이미지 누락'), 'Unsafe non-raster mime attachment must fall back safely');
  assert.ok(res.cleanedSource.includes('![그래프](hwpx-img://att_1)'), 'cleanedSource must keep compact hwpx-img token');

  // Standalone HWPX export embeds binary + manifest + scaled <hp:pic> + clean Markdown bullets
  const pkg = engine.buildHwpxPackageFiles(md, new Date('2026-05-01T00:00:00Z'), { attachments });
  const sec0 = pkg.files['Contents/section0.xml'];
  const hpf = pkg.files['Contents/content.hpf'];
  assertWellFormedXml(sec0, 'Section XML with attached image & Markdown cleanup');
  assertWellFormedXml(hpf, 'content.hpf with embedded user image item');
  assert.ok(Object.keys(pkg.binaryFiles).some(k => k.startsWith('BinData/userimg_') && k.endsWith('.png')), 'Binary PNG must be staged under BinData');
  assert.ok(hpf.includes('media-type="image/png"') && hpf.includes('isEmbeded="1"'), 'content.hpf must declare embedded PNG item');
  assert.ok(sec0.includes('<hp:pic ') && sec0.includes('<hp:imgRect>') && sec0.includes('<hc:img binaryItemIDRef="userimg_'), 'Section XML must emit full OWPML <hp:pic>');
  assert.ok(sec0.includes('• ') && sec0.includes('  ◦ ') && sec0.includes('│ 인용 메모'), 'Bullets and quotes must convert cleanly');
  assert.ok(!sec0.includes('`code`') && sec0.includes('code') && sec0.includes('기울임'), 'Inline backticks and emphasis asterisks must unwrap cleanly');
  assert.ok(sec0.includes('참고 (https://example.com)'), 'Markdown links must render readably in HWPX');

  // Template cell export + re-render round-trip preserves container width clamp and shows photo
  const sampleFiles = engine.buildSampleWorksheetTemplateFiles(new Date('2026-05-01T00:00:00Z'));
  const inspected = engine.inspectHwpxSectionSlots(sampleFiles['Contents/section0.xml']);
  const bodySlot = inspected.slots.find(s => s.placeholders[0]?.full === '{{본문}}');
  const merged = engine.applyEditsToHwpxTemplateFiles(sampleFiles, [
    { sectionPath: 'Contents/section0.xml', slotId: bodySlot.slotId, mode: 'replace', rawText: '그래프 첨부:\n![그래프](hwpx-img://att_1)' }
  ], { attachments });
  assertWellFormedXml(merged.files['Contents/section0.xml'], 'Template cell with attached image section0.xml');
  const picWidthMatch = /<hp:pic\b[\s\S]*?<hp:sz width="(\d+)"/.exec(merged.files['Contents/section0.xml']);
  assert.ok(picWidthMatch && Number(picWidthMatch[1]) <= bodySlot.maxContentWidth, 'Attached picture must clamp within table cell maxContentWidth');

  const rtPreview = engine.renderHwpxTemplatePreviewHtml(merged.files, { edits: [], binaryFiles: merged.binaryFiles });
  assert.ok(rtPreview.includes('class="hwpx-pic-img" src="data:image/png;base64,'), 'Re-rendered HWPX template preview must display newly attached BinData image');
});

test('Editable target extraction, text metrics, AI helper removal, and workspace backup validator work accurately', () => {
  // 1. Text metrics (UTF-8 / NEIS bytes)
  const metrics = engine.countTextMetrics('안녕 ab');
  assert.equal(metrics.chars, 5);
  assert.equal(metrics.charsNoSpace, 4);
  assert.equal(metrics.bytes, 9);

  // 2. Collect editable targets on worksheet & verify AI helper functions are removed
  assert.equal(engine.collectHwpxAiTargets, undefined);
  assert.equal(engine.buildHwpxAiPrompt, undefined);
  assert.equal(engine.parseAiSlotBatchResponse, undefined);

  const sampleFiles = engine.buildSampleWorksheetTemplateFiles(new Date('2026-05-01T00:00:00Z'));
  const slots = engine.inspectHwpxSectionSlots(sampleFiles['Contents/section0.xml']).slots.map(s => ({
    ...s,
    sectionPath: 'Contents/section0.xml',
    uid: `Contents/section0.xml::${s.slotId}`
  }));
  const targets = engine.collectHwpxEditableTargets(slots);
  assert.ok(targets.some(t => t.hasPlaceholder && t.recommended), 'Placeholder cell must be marked recommended');
  const bodyTarget = targets.find(t => t.hasPlaceholder);
  assert.ok(bodyTarget.contextHint, 'Context hint from previous cells should be captured');

  // 3. Snapshot validation
  assert.equal(engine.validateWorkspaceSnapshotPayload(null).valid, false);
  const validSnap = engine.validateWorkspaceSnapshotPayload({
    version: 1,
    rawInputValue: '초안 $x^2$',
    attachments: [
      { id: 'att_1', base64: 'AAAA', mime: 'image/png' },
      { id: 'evil', base64: 'AAAA', mime: 'text/html' }
    ],
    customSnippets: [{ label: '테스트', snippet: 'abc' }]
  });
  assert.equal(validSnap.valid, true);
  assert.equal(validSnap.snapshot.attachments.length, 1, 'Non-image attachments must be filtered out on restore');
  assert.equal(validSnap.snapshot.customPresets, undefined);
});
