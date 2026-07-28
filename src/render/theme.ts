/**
 * 配色与尺寸。从浏览器 demo 的黏土 3D 质感移过来 ——
 * canvas 没有 box-shadow，所以「厚度」靠手工画：
 * 底部深色垫层 + 主体渐变 + 顶部高光条。
 */

export const T = {
  sky1: '#a8d8f0',
  sky2: '#cfeeda',
  grass: '#7cc576',

  wood: '#c8956c',
  woodDark: '#a9764f',
  woodDeep: '#8a5c39',

  card: '#fffdf7',
  ink: '#3d4a3f',
  inkSoft: '#6b7a6d',

  accent: '#ffb43f',
  accentDark: '#e08a1e',
  moss: '#5c7a4a',
  clay: '#c4553f',

  overlay: 'rgba(20,30,22,0.62)',
  white: '#ffffff',
} as const;

/** 品种外观：每个品种一个能一眼认出的动物 + 独立底色。 */
export const BREEDS: { color: string; face: string; name: string }[] = [
  { color: '#fdf3dc', face: '🐑', name: '绵羊' },
  { color: '#ffd166', face: '🐤', name: '小鸡' },
  { color: '#5aa9e6', face: '🐮', name: '奶牛' },
  { color: '#ef8a87', face: '🐷', name: '小猪' },
  { color: '#7ac74f', face: '🐸', name: '青蛙' },
  { color: '#b07de0', face: '🐰', name: '兔子' },
  { color: '#ff9f45', face: '🦊', name: '狐狸' },
  { color: '#3fc1c9', face: '🐴', name: '小马' },
  { color: '#e07a9f', face: '🦙', name: '羊驼' },
];

export const FONT =
  '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", sans-serif';

export function font(size: number, weight: number | string = 400): string {
  return `${weight} ${size}px ${FONT}`;
}
