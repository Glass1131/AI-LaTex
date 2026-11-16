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
