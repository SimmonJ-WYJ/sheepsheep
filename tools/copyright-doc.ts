/**
 * 生成软著申请要用的源代码文档。
 *
 *   npm run copyright
 *
 * 软著（计算机软件著作权登记）对源代码文档的格式要求很死，
 * 最常见的退回原因就是格式不对而不是内容不行：
 *
 *   - 提交**前 30 页 + 后 30 页**（不足 60 页则全部提交）
 *   - **每页不少于 50 行**  ← 退回率最高的一条
 *   - 页眉要有软件全称 + 版本号，页脚要有页码
 *   - 不能出现其他单位/个人的著作权信息
 *
 * 这个脚本负责把这些机械要求处理掉：按固定顺序收集源码、去空行、
 * 每 50 行切一页、取首尾各 30 页、加页眉页脚。
 *
 * ⚠️ 格式要求会变，提交前请对照中国版权保护中心当期的《填表说明》核对一遍。
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SOFTWARE_NAME = '羊群大整理小游戏软件';
const VERSION = 'V1.0';
const LINES_PER_PAGE = 50;
const PAGES_EACH_END = 30;

const OUT_DIR = 'copyright';
const ROOT = process.cwd();

/**
 * 收录顺序刻意固定：核心逻辑 → 变现 → 平台 → 渲染 → 入口。
 * 这样前 30 页正好是算法最密集的部分（求解器、生成器），
 * 审查员翻开第一页看到的就是有实质技术内容的代码，而不是配置。
 */
const INCLUDE_DIRS = [
  'src/core',
  'src/monetize',
  'src/platform',
  'src/render',
  'src/canvas-dev',
];

const EXT = ['.ts'];

/**
 * 提交文件的净化替换表。
 *
 * **只作用于生成出来的文档，不动仓库里的源码。**
 *
 * 为什么要分开：仓库里点名竞品、写明「它哪里做错了」是有价值的工程文档，
 * 后来的维护者需要知道每个设计决策在回避什么。但软著申请文件里
 * 反复点名其他公司的产品、还带评价性措辞，既有不必要的风险也不专业。
 *
 * 平台名（抖音 / 微信 / 苹果）不在此列 —— 接入某平台的代码里出现该平台名称
 * 是完全正常的，任何真实软件都这样。
 */
const SANITIZE: [RegExp, string][] = [
  [/《羊了个羊》/g, '同类产品'],
  [/羊了个羊/g, '同类产品'],
  [/最气人的地方之一/g, '体验上的明显缺陷'],
  [/最招骂的那种体感/g, '容易引起负面评价的体验'],
  [/挨骂最多的地方/g, '被批评最多的环节'],
  [/它压根没有/g, '其未实现'],
];

function sanitize(text: string): string {
  let out = text;
  for (const [re, to] of SANITIZE) out = out.replace(re, to);
  return out;
}

function collect(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (EXT.some((e) => name.endsWith(e))) out.push(p);
    }
  };
  walk(dir);
  return out;
}

interface Line {
  text: string;
  file: string;
}

function gatherLines(): Line[] {
  const lines: Line[] = [];
  for (const dir of INCLUDE_DIRS) {
    for (const file of collect(join(ROOT, dir))) {
      const rel = relative(ROOT, file);
      // 文件分隔标记 —— 让审查员能看出文件边界
      lines.push({ text: `/* ===== ${rel} ===== */`, file: rel });
      for (const raw of readFileSync(file, 'utf8').split('\n')) {
        const t = raw.replace(/\s+$/, '');
        // 去掉空行：软著要求每页不少于 50 行**有效**行，
        // 留着空行会让页数虚高、单页有效行数不够而被退回。
        if (t.trim() === '') continue;
        lines.push({ text: t, file: rel });
      }
    }
  }
  return lines;
}

function paginate(lines: Line[]): Line[][] {
  const pages: Line[][] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) {
    pages.push(lines.slice(i, i + LINES_PER_PAGE));
  }
  return pages;
}

function render(pages: Line[][], startNo: number): string {
  const parts: string[] = [];
  pages.forEach((page, i) => {
    const no = startNo + i;
    parts.push(`${SOFTWARE_NAME} ${VERSION}`.padEnd(60) + `第 ${no} 页`);
    parts.push('');
    for (const l of page) parts.push(sanitize(l.text));
    parts.push('');
    parts.push(`— 第 ${no} 页 —`);
    parts.push('\f'); // 分页符，转 Word/PDF 时会真的分页
  });
  return parts.join('\n');
}

function main(): void {
  const lines = gatherLines();
  const pages = paginate(lines);
  mkdirSync(join(ROOT, OUT_DIR), { recursive: true });

  let body: string;
  let note: string;

  if (pages.length <= PAGES_EACH_END * 2) {
    body = render(pages, 1);
    note = `代码总量 ${lines.length} 有效行 = ${pages.length} 页，不足 60 页，**全部提交**。`;
  } else {
    const head = pages.slice(0, PAGES_EACH_END);
    const tail = pages.slice(-PAGES_EACH_END);
    const tailStartNo = pages.length - PAGES_EACH_END + 1;
    body =
      render(head, 1) +
      `\n\n${'='.repeat(70)}\n` +
      `（此处省略第 ${PAGES_EACH_END + 1} 页至第 ${tailStartNo - 1} 页，共 ${
        pages.length - PAGES_EACH_END * 2
      } 页）\n` +
      `${'='.repeat(70)}\n\n\f` +
      render(tail, tailStartNo);
    note =
      `代码总量 ${lines.length} 有效行 = ${pages.length} 页。` +
      `按要求提交**前 ${PAGES_EACH_END} 页 + 后 ${PAGES_EACH_END} 页**，共 ${
        PAGES_EACH_END * 2
      } 页。`;
  }

  writeFileSync(join(ROOT, OUT_DIR, '源代码.txt'), body, 'utf8');

  // 顺手做一次第三方名称自查 —— 软著不允许出现其他单位的著作权信息
  const suspects = ['Copyright', 'copyright', '(c)', '©', 'All rights reserved', 'Licensed under'];
  const hits: string[] = [];
  for (const l of lines) {
    for (const s of suspects) {
      if (l.text.includes(s)) hits.push(`${l.file}: ${l.text.trim().slice(0, 70)}`);
    }
  }

  console.log('\n软著源代码文档已生成\n');
  console.log(`  ${note}`);
  console.log(`  输出：${OUT_DIR}/源代码.txt`);
  console.log(`  软件名称：${SOFTWARE_NAME} ${VERSION}`);
  console.log(`  每页 ${LINES_PER_PAGE} 行，已去空行\n`);

  console.log('  自查：第三方著作权信息');
  if (hits.length === 0) {
    console.log('    ✅ 没有发现 Copyright / © / Licensed under 之类的字样\n');
  } else {
    console.log(`    ⚠️  发现 ${hits.length} 处，提交前必须清掉：`);
    for (const h of hits.slice(0, 10)) console.log(`       ${h}`);
    console.log();
  }

  // 报一下净化了多少处竞品名称
  let sanitized = 0;
  for (const l of lines) {
    if (sanitize(l.text) !== l.text) sanitized++;
  }
  console.log('  自查：竞品名称与评价性措辞');
  console.log(`    已在提交文件中净化 ${sanitized} 处（仓库源码不动）\n`);

  // 末页天然会短（源码到头了），提前说清楚，免得以为是 bug
  const lastPageLines = pages[pages.length - 1].length;
  if (lastPageLines < LINES_PER_PAGE) {
    console.log(`  说明：最后一页只有 ${lastPageLines} 行 —— 那是源码真正的结尾，正常。`);
    console.log('        「每页 50 行」针对的是正文页，末页允许不满。\n');
  }

  console.log('  还要人工确认的两件事：');
  console.log('    1. 通读一遍 copyright/源代码.txt，确认没有漏掉的第三方名称');
  console.log('    2. 把 txt 贴进 Word，设置真正的页眉页脚后再导出 PDF\n');
}

main();
