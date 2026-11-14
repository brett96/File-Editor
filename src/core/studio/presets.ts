/**
 * Ready-made animated titles: each preset builds one or more ordinary clips (text, colour
 * bars) with keyframes, so everything about them can be changed afterwards.
 */
import { solidClip, textClip } from './build';
import { anim, defaultThree, sid, type Animatable, type Easing, type Keyframe, type Project, type SolidClip, type TextClip, type VisualClip } from './model';

export type TitlePreset = 'lowerThird' | 'fadeTitle' | 'typewriter' | 'slideUp' | 'pop' | 'swing3d' | 'credits';

export const TITLE_PRESETS: { id: TitlePreset; label: string; hint: string }[] = [
  { id: 'lowerThird', label: 'Lower third (name and role)', hint: 'A bar slides in at the bottom left with a name and a smaller line under it.' },
  { id: 'fadeTitle', label: 'Title: fade and drift in', hint: 'A large centred title fades in while growing slightly.' },
  { id: 'typewriter', label: 'Title: typewriter', hint: 'The letters appear one at a time.' },
  { id: 'slideUp', label: 'Title: slide up', hint: 'Rises into place from below.' },
  { id: 'pop', label: 'Title: pop', hint: 'Springs in past its size and settles.' },
  { id: 'swing3d', label: 'Title: 3D swing', hint: 'Swings in like a door, in perspective.' },
  { id: 'credits', label: 'Scrolling credits', hint: 'Lines of text roll from the bottom to the top.' },
];

const keys = (...k: [number, number, Easing?][]): Animatable => ({ value: k[0][1], keys: k.map(([t, v, e]): Keyframe => ({ t, v, ease: e ?? 'linear' })) });

/** The clips of a title preset starting at `at`, top layer first. Clips of one preset are linked so they move together. */
export function titlePreset(p: Project, id: TitlePreset, at: number): VisualClip[] {
  const { width: W, height: H } = p;
  const base = textClip(p, at);
  const text = (patch: Partial<TextClip>): TextClip => ({ ...base, id: sid('C'), ...patch }) as TextClip;
  switch (id) {
    case 'lowerThird': {
      const link = sid('L');
      const left = W * 0.06;
      const barW = 0.46;
      const barH = 0.15;
      const y = H * 0.8;
      const slide = (to: number): Animatable => keys([0, to - W * 0.6, 'easeOut'], [0.6, to]);
      const bar: SolidClip = {
        ...solidClip(p, at, '#111827'),
        name: 'Lower third bar',
        linkId: link,
        size: { w: barW, h: barH },
        transform: { ...base.transform, x: slide(left + (W * barW) / 2), y: anim(y), opacity: anim(0.88) },
        effects: { ...base.effects, fadeOut: 0.4 },
      };
      const accent: SolidClip = {
        ...solidClip(p, at, '#3b82f6'),
        name: 'Lower third accent',
        linkId: link,
        size: { w: 0.008, h: barH },
        transform: { ...base.transform, x: slide(left + W * 0.004), y: anim(y) },
        effects: { ...base.effects, fadeOut: 0.4 },
      };
      const line = (name: string, value: string, size: number, dy: number, delay: number, bold: boolean): TextClip =>
        text({
          name,
          text: value,
          size,
          bold,
          align: 'left',
          anchor: 'left',
          linkId: link,
          transform: { ...base.transform, x: slide(left + W * 0.025), y: anim(y + dy), opacity: keys([0, 0], [delay, 0], [delay + 0.4, 1]) },
          effects: { ...base.effects, fadeOut: 0.4 },
        });
      return [line('Lower third name', 'Full Name', Math.round(H * 0.052), -H * 0.026, 0.25, true), line('Lower third role', 'Role or location', Math.round(H * 0.032), H * 0.034, 0.4, false), accent, bar];
    }
    case 'fadeTitle':
      return [text({ name: 'Title', text: 'Your Title', size: Math.round(H / 7), transform: { ...base.transform, scale: keys([0, 0.92, 'easeOut'], [base.duration, 1.04]), opacity: keys([0, 0, 'easeOut'], [1, 1]) }, effects: { ...base.effects, fadeOut: 0.6, shadow: true } })];
    case 'typewriter':
      return [text({ name: 'Typewriter', text: 'Typed one letter at a time', font: '"Courier New", monospace', bold: false, size: Math.round(H / 14), reveal: keys([0, 0], [2, 1]) })];
    case 'slideUp':
      return [text({ name: 'Title', text: 'Your Title', transform: { ...base.transform, y: keys([0, H / 2 + H * 0.18, 'easeOut'], [0.7, H / 2]), opacity: keys([0, 0, 'easeOut'], [0.5, 1]) }, effects: { ...base.effects, fadeOut: 0.4 } })];
    case 'pop':
      return [text({ name: 'Title', text: 'Your Title', transform: { ...base.transform, scale: { value: 1, keys: [{ t: 0, v: 0, ease: 'bezier', bez: [0.3, 1.7, 0.5, 1] }, { t: 0.55, v: 1, ease: 'linear' }] } }, effects: { ...base.effects, fadeOut: 0.3 } })];
    case 'swing3d':
      return [text({ name: 'Title', text: 'Your Title', three: { ...defaultThree(), rotY: keys([0, -85, 'easeOut'], [0.9, 0]) }, transform: { ...base.transform, opacity: keys([0, 0], [0.35, 1]) }, effects: { ...base.effects, fadeOut: 0.4, shadow: true } })];
    case 'credits': {
      const lines = 'Directed by\nYour Name\n\nProduced by\nYour Name\n\nMusic\nYour Name\n\nThanks for watching';
      const size = Math.round(H / 18);
      const tall = lines.split('\n').length * size * 1.2;
      return [text({ name: 'Credits', text: lines, bold: false, size, duration: 12, transform: { ...base.transform, y: keys([0, H + tall / 2], [12, -tall / 2]) } })];
    }
  }
}
