/**
 * The guided tour. OWNER: content agent.
 *
 * Eight short lessons for a curious adult. Each step says "set up the tunnel like this, then look
 * at that". Writing rules: warm, precise, plain language, short paragraphs, every technical word
 * explained in a line, and physically correct. In particular:
 *  - lift is a pressure difference AND air being turned downward: one physics, two descriptions;
 *  - the "equal transit time" story is a myth (air over the top arrives first);
 *  - induced drag comes from the wingtip vortices and the downwash they create.
 *
 * Design notes:
 *  - The lesson panel replays a lesson from the state it started in, so every step is
 *    deterministic. The FIRST step of a lesson therefore loads a preset and a full baseline view
 *    and always sets `compare` explicitly; later steps only change what they need to.
 *  - `highlight` paths must exist in PARAM_SPECS (checked by tests).
 *  - Aircraft numbers quoted in the text come from docs/AIRCRAFT_DATA.md.
 */
import type { ViewSettings } from '../state/params';
import { deepMerge, type DeepPartial } from '../state/store';
import type { GlossaryEntry, Lesson } from './types';

type ViewPatch = DeepPartial<ViewSettings>;

/** Baseline view for the first step of every lesson: nothing paused, nothing exotic switched on. */
const BASE_VIEW: ViewPatch = {
  flowMode: 'both',
  colorBy: 'pressure',
  showSurfacePressure: true,
  showForces: true,
  showSpanLoad: false,
  paused: false,
  playbackSpeed: 1,
  rake: { mode: 'vertical', eta: 0.35, height: 0, count: 24 },
};

/** BASE_VIEW with overrides (deep-merged, so `rake: { mode }` keeps the other rake fields). */
const view = (overrides: ViewPatch = {}): ViewPatch => deepMerge(BASE_VIEW, overrides);

export const LESSONS: readonly Lesson[] = [
  /* ---------------------------------------------------------------------------------------- */
  {
    id: 'what-is-lift',
    title: 'What is lift?',
    summary: 'See why a wing holds an airplane up: pressure, speed, and air pushed downward.',
    minutes: 6,
    steps: [
      {
        id: 'what-is-lift-welcome',
        title: 'Welcome to the wind tunnel',
        body: `
<p>In a wind tunnel the wing stays still and the air moves past it. It is the same physics as flying through calm air, only easier to watch.</p>
<p>Air enters from the left. The smoke lines trace the paths the air takes, and the drifting dots show how it moves. The colours painted on the wing show <strong>pressure</strong>, the push of the air on the surface.</p>
<p>Look for the arrow pointing up from the wing. That is <strong>lift</strong>, the force that holds an airplane in the sky.</p>`,
        tryIt:
          'Follow the smoke as it splits at the front of the wing and rejoins at the back. Do the lines above the wing squeeze closer together than the lines below?',
        apply: {
          preset: 'demo-rect',
          flow: { alphaDeg: 5, airspeed: 60, altitude: 0 },
          view: view(),
          compare: null,
        },
        camera: 'overview',
      },
      {
        id: 'what-is-lift-pressure',
        title: 'Pressure, in colour',
        body: `
<p>Pressure is just air pushing on a surface. Every patch of the wing's skin is pushed by the air above it and the air below it.</p>
<p>The colours compare that push with the calm air far away. <strong>Blue</strong> means lower pressure than normal, white means about normal, and <strong>red</strong> means higher.</p>
<p>Here the top of the wing is mostly blue and the underside is a little red. The air pushes up on the bottom harder than it pushes down on the top. Add up that difference over the whole wing and you get lift.</p>`,
        tryIt:
          'Raise the angle of attack and watch the colours deepen: bluer on top, redder underneath, and a longer lift arrow.',
        apply: { view: { flowMode: 'streamlines' } },
        camera: 'overview',
        highlight: ['flow.alphaDeg'],
      },
      {
        id: 'what-is-lift-fast-air',
        title: 'Fast air, low pressure',
        body: `
<p>Why is the pressure lower on top? Because the air up there is moving faster than the air far away.</p>
<p>Fast air and low pressure always arrive together. In a smooth flow, where the air speeds up its pressure drops, and where it slows down its pressure rises. This is <strong>Bernoulli's principle</strong>. It describes the trade, but it does not say what makes the air speed up in the first place. The wing's shape and tilt do that, by bending the whole flow around it.</p>
<p>Because fast air and low pressure go together, the blue smoke over the top is also the fastest air. Watch the puffs on each smoke line: they are released at equal time steps, so they spread apart where the air is fast.</p>`,
        tryIt:
          'Look at the top of the wing: the fastest, bluest air sits just behind the front edge.',
        apply: { view: { colorBy: 'pressure', flowMode: 'streamlines' } },
        camera: 'side',
      },
      {
        id: 'what-is-lift-downwash',
        title: 'The wing pushes air down',
        body: `
<p>From the side, air arrives level at the front of the wing, but behind the wing the smoke is tilted downward. The wing has <strong>turned the air downward</strong>.</p>
<p>Turning air takes a force, and forces come in pairs. If the wing pushes air down, the air pushes the wing up. This is Newton's third law at work. The downward-moving air behind the wing is called <strong>downwash</strong>.</p>
<p>This is not a rival theory to the pressure story. It is the same physics told two ways: the pressure difference is how the wing pushes on the air, and the downwash is what that push does to the air.</p>`,
        tryIt:
          'Raise the angle of attack and watch the smoke behind the wing bend further down while the lift arrow grows.',
        apply: {
          view: {
            colorBy: 'pressure',
            flowMode: 'streamlines',
            rake: { mode: 'vertical', eta: 0.2, count: 32 },
          },
        },
        camera: 'side',
        highlight: ['flow.alphaDeg'],
      },
      {
        id: 'what-is-lift-myth',
        title: 'Myth-buster: the race that never happens',
        body: `
<p>You may have heard that air splits at the front of the wing, and that the two halves must meet again at the back at the same moment. So the air over the longer top path has to go faster. <strong>This is a myth.</strong></p>
<p>Test it. Release a smoke pulse: each pulse marks air that was side by side at the front of the wing. The air that went over the top reaches the back edge <strong>first</strong>, well ahead of the air that went underneath.</p>
<p>The top air is much faster than an equal-time race would make it. The real cause is the wing's shape and tilt, which reshape the flow and the pressure all around it.</p>`,
        tryIt:
          'Press the smoke pulse button in the top bar. Playback is slowed down so you can see which marker reaches the back edge first.',
        apply: {
          view: {
            colorBy: 'pressure',
            flowMode: 'streamlines',
            playbackSpeed: 0.3,
            rake: { mode: 'vertical', eta: 0.35, count: 24 },
          },
        },
        camera: 'side',
      },
      {
        id: 'what-is-lift-both-views',
        title: 'Two views, one wing',
        body: `
<p>Lift is a push, and a push has a cause. There are two ways to describe it, and <strong>both are true at the same time</strong>:</p>
<ul>
<li><strong>Pressure view:</strong> the air pushes up on the underside more than it pushes down on the top.</li>
<li><strong>Downwash view:</strong> the wing pushes air downward, so the air pushes the wing upward.</li>
</ul>
<p>You can make more lift in four ways: a bigger angle of attack, more speed, a bigger wing, or denser air. The next lessons explore each one.</p>`,
        tryIt:
          'Change the angle of attack, the airspeed and the altitude one at a time. Which gives the biggest change in lift?',
        apply: { view: { colorBy: 'pressure', flowMode: 'both', playbackSpeed: 1 } },
        camera: 'overview',
        highlight: ['flow.alphaDeg', 'flow.airspeed', 'flow.altitude'],
      },
    ],
  },

  /* ---------------------------------------------------------------------------------------- */
  {
    id: 'angle-and-stall',
    title: 'Angle of attack and stall',
    summary: 'Tilt the wing for more lift, until the air can no longer follow it.',
    minutes: 6,
    steps: [
      {
        id: 'angle-and-stall-tilt',
        title: 'Tilt the wing, get more lift',
        body: `
<p>The <strong>angle of attack</strong> is the angle between the wing's <em>chord</em> (an imaginary line from its front edge to its back edge) and the oncoming air. It is not the angle of the plane to the ground.</p>
<p>At small angles, lift grows in a steady, straight-line way: each extra degree adds about the same amount. That is why a pilot can fine-tune lift so precisely with a small movement of the nose.</p>`,
        tryIt:
          'Slide the angle of attack from 0° to 10° in small steps and watch the lift arrow grow. Even at 0° there is some lift, because the wing section is curved.',
        apply: {
          preset: 'demo-rect',
          flow: { alphaDeg: 2, airspeed: 60, altitude: 0 },
          view: view({ flowMode: 'both' }),
          compare: null,
        },
        camera: 'side',
        highlight: ['flow.alphaDeg'],
      },
      {
        id: 'angle-and-stall-stagnation',
        title: 'How the flow rearranges',
        body: `
<p>This cross-section shows one slice through the wing. At the front, the smoke splits at the <strong>stagnation point</strong>, where the air comes almost to a halt.</p>
<p>As the angle grows, that dividing point slides back underneath the nose. The air going over the top now has to whip around the front corner, which makes a strong low-pressure spot just behind the leading edge: the <strong>suction peak</strong>.</p>
<p>Most of a wing's lift comes from suction on the top surface, and much of it is made near the front.</p>`,
        tryIt: 'Raise the angle from 0° to 12° and watch the dividing point creep under the nose.',
        apply: {
          flow: { alphaDeg: 8 },
          view: { flowMode: 'streamlines', sectionEta: 0.35 },
        },
        camera: 'section',
        highlight: ['flow.alphaDeg'],
      },
      {
        id: 'angle-and-stall-stall',
        title: 'Stall: the air lets go',
        body: `
<p>Raise the angle too far and something breaks. The air can no longer bend smoothly around the top of the wing. It <strong>separates</strong>: it peels away from the surface and leaves a slow, swirling, messy wake behind.</p>
<p>That is a <strong>stall</strong>. The suction on top collapses, so lift falls, and the messy wake makes drag shoot up.</p>
<p>The wing has not run out of speed. It has run out of angle. For a wing like this one, stall begins at about 18°.</p>`,
        tryIt:
          'Look at the flow over the top of the wing and at the lift reading. Also look for the regions that the wing view marks with a different tint where the flow has separated.',
        apply: { flow: { alphaDeg: 20 }, view: { flowMode: 'both' } },
        camera: 'section',
        highlight: ['flow.alphaDeg'],
      },
      {
        id: 'angle-and-stall-recover',
        title: 'Recovering from a stall',
        body: `
<p>The cure for a stall is simple, and a little surprising: <strong>lower the nose</strong>. That cuts the angle of attack, the flow reattaches, and the lift comes back.</p>
<p>Adding speed or power does not fix the cause. The air has let go because of the angle, so the angle is what must change.</p>`,
        tryIt:
          'Sweep the angle slowly from 5° up to 20°. Find the angle that gives the most lift. That peak is the edge of the stall.',
        apply: { flow: { alphaDeg: 12 }, view: { flowMode: 'streamlines' } },
        camera: 'side',
        highlight: ['flow.alphaDeg'],
      },
      {
        id: 'angle-and-stall-not-speed',
        title: 'Stall is about angle, not speed',
        body: `
<p>You often hear that a plane stalls "when it flies too slowly". That is a useful rule of thumb, but the real rule is about angle: a wing stalls whenever its angle of attack gets too big, at <em>any</em> speed.</p>
<p>Slow flight matters because at low speed you need a bigger angle to make enough lift. A plane's stall speed is the speed at which the biggest usable angle only just makes enough lift to hold it up. Heavier planes, and planes in steep turns, need more lift, so they stall at higher speeds.</p>`,
        tryIt:
          'This wing is stalled at about 230 knots. Change the airspeed up and down: the stall stays. Only lowering the angle brings the flow back.',
        apply: { flow: { alphaDeg: 20, airspeed: 120 }, view: { flowMode: 'both' } },
        camera: 'section',
        highlight: ['flow.airspeed', 'flow.alphaDeg'],
      },
    ],
  },

  /* ---------------------------------------------------------------------------------------- */
  {
    id: 'speed-and-density',
    title: 'Speed and air density',
    summary: 'Lift grows with the square of speed and with the thickness of the air.',
    minutes: 6,
    steps: [
      {
        id: 'speed-and-density-squared',
        title: 'Lift grows with speed squared',
        body: `
<p>Lift depends on how hard the air pushes on the wing. That push is called <strong>dynamic pressure</strong>: half the air's density times its speed squared.</p>
<p>The key is the square. Twice the speed does not give twice the lift but <strong>four times</strong>. Three times the speed gives nine times.</p>`,
        tryIt:
          'Note the lift at about 58 knots. Then set the airspeed to about 117 knots, twice as fast. The lift should be about four times larger.',
        apply: {
          preset: 'demo-rect',
          flow: { alphaDeg: 4, airspeed: 30, altitude: 0 },
          view: view({ flowMode: 'both' }),
          compare: null,
        },
        camera: 'side',
        highlight: ['flow.airspeed'],
      },
      {
        id: 'speed-and-density-thin-air',
        title: 'Thin air, less lift',
        body: `
<p>The other half of dynamic pressure is <strong>density</strong>, how much air there is in each cubic metre. Air thins out as you climb. At 10 km (about 33,000 ft) it has only about a third of its sea-level density.</p>
<p>The wing, the angle and the speed are all unchanged, but the air has fewer molecules to push with, so the push is weaker.</p>`,
        tryIt: 'Raise the altitude from 0 to 10,000 m and watch the lift drop to roughly a third.',
        apply: { flow: { alphaDeg: 4, airspeed: 60, altitude: 0 } },
        camera: 'side',
        highlight: ['flow.altitude'],
      },
      {
        id: 'speed-and-density-cruise',
        title: 'Why jets fly fast and high',
        body: `
<p>This is a 737-800 at its normal cruise: about 10 km up (34,000 ft), moving at 234 m/s (about 840 km/h, 455 knots).</p>
<p>That sounds absurdly fast, but the air is so thin that the wing feels only the push it would feel at about 133 m/s (258 knots) at sea level. It needs all that speed to hold up roughly 65 tonnes.</p>
<p>So why go high at all? Thin air also pushes back less on the whole aircraft, so drag is lower at a given speed, and the engines work efficiently there. Fast and high is the cheapest way to go far.</p>`,
        tryIt:
          'Drag the altitude down to 0 without changing the speed. The lift becomes several times the weight: far more than needed, and with a huge drag bill.',
        apply: { preset: 'b737-800' },
        camera: 'side',
        highlight: ['flow.altitude', 'flow.airspeed'],
      },
      {
        id: 'speed-and-density-approach',
        title: 'The same plane, landing',
        body: `
<p>Now the same 737 on final approach: sea level, 72 m/s (about 140 knots). The air is more than three times denser than at cruise altitude, but the plane is moving at less than a third of the speed.</p>
<p>The result is that the push on the wing, the dynamic pressure, is only about a third of its cruise value. The plane still has to hold up almost the same weight, and a smooth, clean wing cannot do that at 7°.</p>
<p>The solution is <strong>flaps</strong> and <strong>slats</strong>, which reshape the wing for slow flight. You will meet them in the last lesson.</p>`,
        tryIt:
          'Compare the lift here with the lift at cruise. With flaps up, this wing falls well short of what it would take to hold the plane up.',
        apply: { preset: 'b737-800', flow: { alphaDeg: 7, airspeed: 72, altitude: 0 } },
        camera: 'side',
        highlight: ['flow.airspeed', 'flow.alphaDeg'],
      },
    ],
  },

  /* ---------------------------------------------------------------------------------------- */
  {
    id: 'tip-vortices',
    title: 'Wingtip vortices and induced drag',
    summary: 'Air spills around the wingtips and swirls. That swirl costs energy.',
    minutes: 7,
    steps: [
      {
        id: 'tip-vortices-spill',
        title: 'Air escapes at the tip',
        body: `
<p>Under a lifting wing the pressure is high, and above it the pressure is low. At the wingtip nothing stops the air under the wing from curling around the end toward the low pressure on top.</p>
<p>That escaping air is rolled up into a spinning tube behind each tip, called a <strong>wingtip vortex</strong>. You are looking at one now, from behind the wing. The smoke is released near the tip so you can watch it spiral.</p>`,
        tryIt:
          'Watch the smoke near the tip wind into a spiral. Raise the angle of attack and the swirl gets stronger.',
        apply: {
          preset: 'demo-rect',
          flow: { alphaDeg: 8, airspeed: 60, altitude: 0 },
          view: view({ flowMode: 'streamlines', rake: { mode: 'tip-vortex' } }),
          compare: null,
        },
        camera: 'behind',
        highlight: ['flow.alphaDeg'],
      },
      {
        id: 'tip-vortices-pair',
        title: 'A pair of whirlpools',
        body: `
<p>Each wing makes one vortex, and the two spin in opposite directions. Between them the air is pushed <strong>down</strong>. Outside them the air is pulled <strong>up</strong>.</p>
<p>That downward push between the vortices is the downwash from the first lesson. In effect, the wake of a lifting wing is a pair of long whirlpools. On a big airliner they can last for minutes, which is why air traffic control spaces out landings.</p>`,
        tryIt:
          'Compare the smoke outside the tip with the smoke inside it: outside it rises, inside it sinks.',
        apply: { view: { flowMode: 'streamlines', rake: { mode: 'tip-vortex' } } },
        camera: 'tip',
      },
      {
        id: 'tip-vortices-induced-drag',
        title: 'The price of lift: induced drag',
        body: `
<p>The downwash tilts the air the wing meets slightly downward. Lift acts at right angles to the air the wing actually feels, so the lift force tilts slightly <em>backward</em>. The backward part is a drag force. It is called <strong>induced drag</strong>, because making lift induces it.</p>
<p>It follows a steep rule: induced drag grows with the <em>square</em> of the lift. Double the lift at the same speed and it quadruples. It matters most in slow flight at high angles, and shrinks in fast cruise.</p>
<p>The lift display along the wing, now switched on, shows how lift is shared out along the span. It fades toward the tips, where the air escapes.</p>`,
        tryIt:
          'Raise the angle of attack from 2° to 6°. The lift roughly doubles, and the induced part of the drag roughly quadruples.',
        apply: {
          flow: { alphaDeg: 2, airspeed: 60, altitude: 0 },
          view: { flowMode: 'both', showSpanLoad: true, rake: { mode: 'vertical' } },
        },
        camera: 'side',
        highlight: ['flow.alphaDeg'],
      },
      {
        id: 'tip-vortices-long-wings',
        title: 'Long wings are efficient',
        body: `
<p>How do you cut induced drag? Spread the same lift across a longer wing. A long, narrow wing moves a large mass of air downward by a little, instead of a small mass by a lot. The downwash is gentler, the vortices are weaker, and the drag is lower.</p>
<p>The measure is <strong>aspect ratio</strong>: the span squared divided by the wing area. This 18 m glider has an aspect ratio of about 31. For the same lift, doubling the span cuts induced drag to a quarter.</p>`,
        tryIt:
          'Shorten the wingspan from 18 m to about 8 m. The smaller wing makes less lift, and its lift-to-drag ratio (the glide performance) drops by about a quarter: each unit of lift now costs more induced drag.',
        apply: {
          preset: 'glider-18m',
          view: { showSpanLoad: false, rake: { mode: 'tip-vortex' } },
        },
        camera: 'behind',
        highlight: ['wing.span'],
      },
      {
        id: 'tip-vortices-stubby',
        title: 'A stubby wing for a different job',
        body: `
<p>Now compare the glider with the F-16 fighter. The F-16's wing is short and stubby (aspect ratio about 3.2), so it makes strong tip vortices and a lot of induced drag for the lift it creates.</p>
<p>A fighter does not mind. It needs a small, strong, thin wing that is good at high speed and rolls quickly, and it has an engine to pay for the drag. A glider has no engine and must glide as far as it can, so efficiency is everything.</p>`,
        tryIt: 'In the comparison, look at the lift-to-drag figures of the two wings.',
        apply: { compare: ['glider-18m', 'f16'] },
        camera: 'behind',
      },
    ],
  },

  /* ---------------------------------------------------------------------------------------- */
  {
    id: 'winglets',
    title: 'Winglets and wingtip devices',
    summary: 'Why a 747, a 737 and an A380 each finish their wings differently.',
    minutes: 7,
    steps: [
      {
        id: 'winglets-why',
        title: 'Taming the tip',
        body: `
<p>If the tip vortex wastes energy, can we weaken it? That is what <strong>wingtip devices</strong> try to do. This 737-800 wears <strong>blended winglets</strong>: small wings, 2.4 m tall, curving smoothly up from the tip.</p>
<p>A winglet helps in two ways. It blocks some of the air from curling around the tip. And because it stands in the swirling air, it can be angled so the swirl gives it a small forward push, like a sail. Both save fuel without needing a much longer wing.</p>`,
        tryIt:
          'Drag Tip device size down to 0 and watch the vortex and the Efficiency (lift per drag) figure: without the winglet, every unit of lift costs more drag. Then bring the size back to about 0.14.',
        apply: {
          preset: 'b737-800',
          view: view({ flowMode: 'streamlines', rake: { mode: 'tip-vortex' } }),
          compare: null,
        },
        camera: 'behind',
        highlight: ['wing.tipDevice.size'],
      },
      {
        id: 'winglets-747-400',
        title: '747-400: the canted winglet',
        body: `
<p>The 747-400 was the first jumbo with winglets. They are about 1.8 m tall and lean outward about 30° from vertical, joined to the wing at a visible corner.</p>
<p>On a 64 m wing that is a modest change, but over a flight that burns many tonnes of fuel, a small percentage is a lot of fuel saved.</p>`,
        tryIt:
          'Change the cant angle from about 30° to 90°. At 90° the winglet lies flat and becomes a plain span extension. See how the vortex and the drag respond.',
        apply: { preset: 'b747-400' },
        camera: 'behind',
        highlight: ['wing.tipDevice.cantDeg', 'wing.tipDevice.size'],
      },
      {
        id: 'winglets-747-8',
        title: '747-8: the raked tip',
        body: `
<p>The 747-8 dropped winglets for a <strong>raked tip</strong>: extra wing that stays in the same plane as the rest but sweeps back much more sharply. Boeing used the same idea on the 777 and 787.</p>
<p>A raked tip does the winglet's job by a different route. It makes the wing longer, which reduces induced drag, and its sharp sweep keeps the extra length from adding much shock-wave drag. There is also no corner where a winglet meets the wing.</p>`,
        tryIt:
          'Compare this vortex with the 747-400 one. Change Tip device size and see how extra span changes the swirl.',
        apply: { preset: 'b747-8' },
        camera: 'behind',
        highlight: ['wing.tipDevice.size'],
      },
      {
        id: 'winglets-737-max',
        title: '737 MAX: the split winglet',
        body: `
<p>The 737 MAX replaced the blended winglet with a <strong>split winglet</strong>: a tall upper blade plus a smaller fin pointing down. Together they stand about 2.9 m tall.</p>
<p>The idea is to work the swirl below the tip as well as above it. Boeing credits the design with roughly 1 to 1.5 percent in fuel savings.</p>
<p>The wing underneath is almost the same as on the 737-800, so this pair is a fair test of the tip devices. Look at the <strong>span efficiency</strong> in the comparison: the higher it is, the less drag the tip vortices cost for each unit of lift.</p>`,
        tryIt:
          'In the comparison, the MAX has the slightly higher span efficiency, yet the lift-to-drag ratios come out about level: the MAX is heavier, and its bigger winglet adds a little friction. Tip devices are fine-tuning.',
        apply: { preset: 'b737-max8', compare: ['b737-800', 'b737-max8'] },
        camera: 'behind',
      },
      {
        id: 'winglets-a380',
        title: 'A380: the fence',
        body: `
<p>The A380 uses a <strong>wingtip fence</strong>: a short fin that sticks up and down at the tip. It is the simplest device, and its main job is to block the leak around the tip.</p>
<p>The A380 has a special constraint: airports limit its span to 80 m, so Airbus cannot just make the wing longer. With the span capped, a device at the tip is a cheap way to tame the vortex.</p>
<p>There is no free lunch. Every device adds weight and surface area, which means more friction. The best choice depends on the aircraft, the route and the width of the gate.</p>`,
        tryIt:
          'Change the tip device size and cant angle. How big is the effect on drag? It is small compared with the whole wing, yet worth chasing on a plane this size.',
        apply: { preset: 'a380-800', compare: null },
        camera: 'behind',
        highlight: ['wing.tipDevice.size', 'wing.tipDevice.cantDeg'],
      },
    ],
  },

  /* ---------------------------------------------------------------------------------------- */
  {
    id: 'sweep',
    title: 'Why jets sweep their wings',
    summary: 'Swept-back wings let airliners fly close to the speed of sound.',
    minutes: 6,
    steps: [
      {
        id: 'sweep-speed-of-sound',
        title: 'Flying near the speed of sound',
        body: `
<p>This 737 cruises at about Mach 0.785. <strong>Mach number</strong> is speed divided by the speed of sound, which is about 298 m/s up here where the air is cold. So the plane is moving at roughly 78 percent of the speed of sound.</p>
<p>But the air does not move at the plane's speed everywhere. Over the curved top of the wing it speeds up, and that fast pocket can reach the speed of sound while the plane is still slower. Where it does, a <strong>shock wave</strong> forms and drag climbs steeply. This is called <strong>wave drag</strong>.</p>`,
        tryIt:
          'Raise the airspeed and watch the drag climb. Turn on Engineer mode to see the Mach number and wave drag directly.',
        apply: {
          preset: 'b737-800',
          view: view({ flowMode: 'both' }),
          compare: null,
        },
        camera: 'top',
        highlight: ['flow.airspeed'],
      },
      {
        id: 'sweep-sliding-back',
        title: 'Sweep: sliding the wing back',
        body: `
<p>Sweeping the wing back is the cure. A swept wing meets the air at a slant, and only the part of the wind that is perpendicular to the wing's leading edge counts for building pressure, suction and shocks.</p>
<p>That share is the speed times the cosine of the sweep angle. The 747-400's wing is swept 37.5°, so at Mach 0.85 it behaves roughly as if it were flying at Mach 0.67, slow enough to keep its shock waves weak. A 737, swept 25°, at Mach 0.785 sees about 0.71.</p>`,
        tryIt:
          'Drag Sweep to 0°. At Mach 0.85 the straight wing runs into strong shock waves: the drag more than doubles and the air separates from the top, a high-speed stall. Then sweep it back to 37.5°.',
        apply: { preset: 'b747-400' },
        camera: 'top',
        highlight: ['wing.sweepDeg'],
      },
      {
        id: 'sweep-tip-stall',
        title: 'The price: tips that stall first',
        body: `
<p>Sweep has a cost. On a swept wing, the air near the tips is more likely to separate than the air near the root. Stall tends to begin at the <strong>tips</strong>.</p>
<p>That is bad for two reasons. The ailerons that roll the plane sit near the tips, so they stop working just when the pilot needs them. And the swept-back tips are behind the plane's balance point, so losing lift there pitches the nose up, which deepens the stall.</p>
<p>The cure is <strong>washout</strong>: twist the wing so the tips sit at a smaller angle than the root. Then the stall starts further inboard and the ailerons keep working. Here the 747 has slowed to its approach speed, with its washout taken out.</p>`,
        tryIt:
          'Raise the angle of attack until part of the wing stalls, and note where. Then add washout (try 4° to 6°) and raise the angle again: the stall now starts further inboard.',
        apply: { wing: { washoutDeg: 0 }, flow: { alphaDeg: 12, airspeed: 80, altitude: 0 } },
        camera: 'top',
        highlight: ['flow.alphaDeg', 'wing.washoutDeg'],
      },
      {
        id: 'sweep-straight',
        title: 'When you do not need sweep',
        body: `
<p>A Cessna 172 cruises at about 62 m/s, which is Mach 0.19. There are no shock waves to worry about, so its wing is straight. A straight wing is simpler, lighter, and makes more lift at low speed, which is ideal for slow flight.</p>
<p>Sweep is a trade, not an upgrade. Every wing is a compromise for its job, and airliners choose speed, so they accept the costs of sweep.</p>`,
        tryIt:
          'Sweep the Cessna wing back to 30° and watch the lift fall at the same angle. At 120 knots it is a poor bargain.',
        apply: { preset: 'cessna-172' },
        camera: 'top',
        highlight: ['wing.sweepDeg'],
      },
    ],
  },

  /* ---------------------------------------------------------------------------------------- */
  {
    id: 'b747-vs-b737',
    title: '747 vs 737',
    summary: 'The same physics, very different wings: a jumbo and a workhorse side by side.',
    minutes: 5,
    steps: [
      {
        id: 'b747-vs-b737-meet',
        title: 'Meet the wings',
        body: `
<p>One is the four-engine 747-400, which can take off at up to 397 tonnes. The other is the 737-800, at up to 79 tonnes. The comparison shows their wings side by side.</p>
<p>The 747's wing spans 64 m and covers 525 m². The 737's spans 36 m, with winglets, and covers 125 m². The 747 sweeps its wing back 37.5°, the 737 25°.</p>`,
        tryIt: 'Compare the shapes. Which wing is longer and slimmer in proportion to its size?',
        apply: {
          preset: 'b747-400',
          view: view(),
          compare: ['b747-400', 'b737-800'],
        },
        camera: 'top',
      },
      {
        id: 'b747-vs-b737-loading',
        title: 'Wing loading',
        body: `
<p>The 747 is about five times heavier than the 737 at take-off, but its wing has only four times the area. Divide weight by wing area and you get the <strong>wing loading</strong>: about 640 kg per square metre for the 747 in cruise, and about 520 for the 737.</p>
<p>Weight grows with the volume of the aircraft, but wing area grows only with the square of its size. So simply scaling a plane up loads its wing more heavily, and bigger planes must fly faster or use cleverer wings.</p>`,
        tryIt:
          'In the comparison, notice how similar the lift needed per square metre of wing is, even though the sizes are so different.',
        apply: { compare: ['b747-400', 'b737-800'] },
        camera: 'top',
      },
      {
        id: 'b747-vs-b737-aspect',
        title: 'Slender or stocky?',
        body: `
<p>The 747's aspect ratio is about 7.9. The 737's is about 9.5 to 10. In proportion, the 737 has the longer, slimmer wing.</p>
<p>Why not make the 747's wing longer? A longer wing is heavier, because it must resist more bending, and airports limit the span so the plane fits at its gate and on the taxiways. Every design is a balance.</p>`,
        tryIt:
          'In the comparison, check the lift-to-drag figures. A slimmer wing tends to do better, all else equal.',
        apply: { compare: ['b747-400', 'b737-800'] },
        camera: 'front',
      },
      {
        id: 'b747-vs-b737-speed',
        title: 'Cruising speeds',
        body: `
<p>Now fly the 747-400 on its own. It cruises at Mach 0.85, about 900 km/h. The 737-800 cruises at about Mach 0.785, around 840 km/h.</p>
<p>The 747's greater sweep is the main reason it can go faster before its shock waves grow strong. Different size, different speed, different tip devices, and the same laws of physics underneath.</p>`,
        tryIt:
          'Use the aircraft picker to switch between the two and compare the angle of attack, lift and drag at cruise.',
        apply: { preset: 'b747-400', compare: null },
        camera: 'overview',
      },
    ],
  },

  /* ---------------------------------------------------------------------------------------- */
  {
    id: 'flaps-and-slats',
    title: 'Flaps and slats: flying slowly',
    summary: 'How an airliner reshapes its wings to land at a gentle speed.',
    minutes: 6,
    steps: [
      {
        id: 'flaps-and-slats-problem',
        title: 'The slow-flight problem',
        body: `
<p>A wing shaped for cruise at 840 km/h is a poor wing for landing at 260 km/h. At that speed the air pushes only about a third as hard, and a clean wing falls well short of the lift needed.</p>
<p>Tilting it further is not the answer: it would stall before it made enough lift, and an airliner's tail would scrape the runway. The answer is to change the wing's shape for landing and take-off.</p>`,
        tryIt:
          'Read the lift now and compare it with the weight of the plane. It falls well short.',
        apply: {
          preset: 'b737-800',
          flow: { alphaDeg: 7, airspeed: 72, altitude: 0 },
          wing: { flaps: { deflectionDeg: 0 }, slats: false },
          view: view({ flowMode: 'both' }),
          compare: null,
        },
        camera: 'side',
      },
      {
        id: 'flaps-and-slats-flaps',
        title: 'Flaps: more curve, more lift',
        body: `
<p><strong>Flaps</strong> are hinged panels on the back of the wing. Lowering them bends the back edge of the wing downward, which adds curve (<em>camber</em>). On many airliners they also slide backward as they drop, which adds wing area.</p>
<p>The extra curve turns the air downward more, so the wing makes far more lift at the same angle and the same speed. With 25° of flap, as now, this wing at 7° holds the 737 up. The price is more drag, because the flow is turned harder and the wing gets messier.</p>`,
        tryIt: 'Move the Flaps slider from 0° to 30° and watch both lift and drag rise.',
        apply: { wing: { flaps: { deflectionDeg: 25 } } },
        camera: 'section',
        highlight: ['wing.flaps.deflectionDeg'],
      },
      {
        id: 'flaps-and-slats-slats',
        title: 'Slats: keeping the air attached',
        body: `
<p>Flaps add lift, but they also make the air on top of the wing more likely to let go. <strong>Slats</strong> are small wings along the front edge that slide forward and down. They open a gap that lets air from underneath rush through and re-energise the thin layer of slow air hugging the top surface (the <em>boundary layer</em>). That delays the stall.</p>
<p>So the wing can take a bigger angle of attack before the flow lets go, and a bigger angle means still more lift at low speed.</p>`,
        tryIt:
          'Raise the angle of attack with the slats on and then off (use the Slats switch), and compare where the stall begins.',
        apply: { wing: { flaps: { deflectionDeg: 25 }, slats: true }, flow: { alphaDeg: 12 } },
        camera: 'section',
        highlight: ['flow.alphaDeg'],
      },
      {
        id: 'flaps-and-slats-tradeoff',
        title: 'Lift versus drag: choosing a setting',
        body: `
<p>More flap is not always better. For take-off, pilots use a modest setting, perhaps 5° to 15°. It gives some extra lift with little extra drag, so the engines can still accelerate and climb.</p>
<p>For landing they use 30° or 40°: a lot of lift for slow speed, and a lot of drag, which also helps the plane slow down and descend steeply.</p>`,
        tryIt:
          'Compare flaps at 15° and at 40°. Which setting has the better lift-to-drag ratio? Which would you pick for take-off, and which for landing?',
        apply: { wing: { flaps: { deflectionDeg: 15 }, slats: true }, flow: { alphaDeg: 7 } },
        camera: 'side',
        highlight: ['wing.flaps.deflectionDeg'],
      },
      {
        id: 'flaps-and-slats-cessna',
        title: 'Why a Cessna lands so slowly',
        body: `
<p>A Cessna 172 stalls at around 47 knots (87 km/h) with full flaps, about a third of a 737's landing speed. It carries far less weight for its wing area: about 70 kg per square metre, against about 520 to 630 for a loaded 737.</p>
<p>Wing loading decides landing speed. A heavy load on a small wing needs high speed to make enough lift, even with every high-lift device deployed. That is why big jets need long runways and small planes can land in a field.</p>`,
        tryIt:
          'This Cessna is flying at about 64 knots. Raise the airspeed to about 140 knots, the 737 approach speed, and the Cessna wing would make several times its own weight in lift.',
        apply: {
          preset: 'cessna-172',
          flow: { alphaDeg: 8, airspeed: 33, altitude: 0 },
          wing: { flaps: { deflectionDeg: 20 } },
        },
        camera: 'side',
        highlight: ['flow.airspeed', 'wing.flaps.deflectionDeg'],
      },
    ],
  },
];

export const GLOSSARY: readonly GlossaryEntry[] = [
  {
    term: 'Lift',
    definition:
      'The upward force on a wing. It comes from the air pressing harder on the underside than on the top, which is the same thing as the wing pushing air downward.',
  },
  {
    term: 'Drag',
    definition:
      'The force that resists motion through the air, pointing backward. It includes friction, pressure drag, induced drag and, near the speed of sound, wave drag.',
  },
  {
    term: 'Pressure',
    definition:
      'How hard the air pushes on a surface. In this app blue means pressure lower than the surrounding air and red means higher.',
  },
  {
    term: 'Dynamic pressure',
    definition:
      'Half the air density times speed squared. It measures how hard moving air can push, and it sets how much lift a wing can make.',
  },
  {
    term: 'Bernoulli principle',
    definition:
      'In smooth flow, air that speeds up has lower pressure and air that slows down has higher pressure. It describes how speed and pressure change together.',
  },
  {
    term: 'Chord',
    definition:
      'The distance from the front edge of a wing to its back edge, at one position along the span.',
  },
  {
    term: 'Camber',
    definition:
      'How curved the wing section is. A cambered wing makes lift even at zero angle of attack.',
  },
  {
    term: 'Angle of attack',
    definition:
      'The angle between the wing chord and the oncoming air. It is not the same as the angle of the plane to the ground.',
  },
  {
    term: 'Stall',
    definition:
      'What happens when the angle of attack is so large that the air separates from the top of the wing. Lift falls and drag rises.',
  },
  {
    term: 'Stagnation point',
    definition:
      'The point on the front of the wing where the air splits and comes almost to a stop.',
  },
  {
    term: 'Boundary layer',
    definition:
      'The thin layer of slowed air right next to a surface. Whether it stays attached or peels away decides whether a wing stalls.',
  },
  {
    term: 'Downwash',
    definition:
      'Air pushed downward by a lifting wing. It is the "equal and opposite" side of lift, and it is strongest near the wingtip vortices.',
  },
  {
    term: 'Wingtip vortex',
    definition:
      'A spinning tube of air that forms behind each wingtip, where air curls from the high-pressure underside to the low-pressure top.',
  },
  {
    term: 'Induced drag',
    definition:
      'Drag that comes from making lift. The wingtip vortices tilt the airflow downward, which tips the lift force backward. It grows with the square of the lift.',
  },
  {
    term: 'Aspect ratio',
    definition:
      'Span squared divided by wing area. Long, narrow wings have a high aspect ratio and less induced drag.',
  },
  {
    term: 'Taper',
    definition:
      'The tip chord divided by the root chord. A tapered wing is narrower at the tip, which puts the lift nearer the root and the structure.',
  },
  {
    term: 'Wing loading',
    definition:
      'The weight of the aircraft divided by its wing area. A higher wing loading means higher speeds for take-off and landing.',
  },
  {
    term: 'Winglet',
    definition:
      'A small upward-pointing wing at the tip that weakens the wingtip vortex and reduces induced drag.',
  },
  {
    term: 'Raked tip',
    definition:
      'An extension of the wing tip that stays in the plane of the wing but sweeps back sharply. It adds span to cut induced drag.',
  },
  {
    term: 'Sweep',
    definition:
      'The angle by which the wing is swept back. It delays the shock waves that form near the speed of sound.',
  },
  {
    term: 'Mach number',
    definition:
      'Speed divided by the speed of sound. Mach 1 is the speed of sound, which is about 295 m/s at airliner cruise altitude.',
  },
  {
    term: 'Wave drag',
    definition:
      'The extra drag caused by shock waves forming over the wing when the air on top reaches the speed of sound.',
  },
  {
    term: 'Washout',
    definition:
      'A twist in the wing so the tips sit at a lower angle of attack than the root. It makes the root stall first.',
  },
  {
    term: 'Flap',
    definition:
      'A hinged panel on the back of the wing that bends downward to add camber and lift for slow flight, at the price of extra drag.',
  },
  {
    term: 'Slat',
    definition:
      'A small wing along the front edge that moves forward and down to delay stall and let the wing fly at higher angles.',
  },
];
