# Aircraft data behind the presets

Everything in `src/state/presets.ts` comes from this table. **Published** means a figure
found in a public source (URL listed). **Estimate** means an engineering guess made for this
project: manufacturers do not publish these, or no source was reachable while researching.
The wind tunnel is a teaching tool, so estimates only need to be plausible, and they can be
retuned later.

## How the wind-tunnel numbers are derived

| Wind-tunnel field       | Derivation                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wing.span` (base span) | Winglets: published overall span minus `2 h sin(cant)`. Raked tips: published span / (1 + `tipDevice.size`). Otherwise the published span.                          |
| `wing.rootChord`        | From published reference area S: `S_base = c_r * b/2 * [(1 + taper) + yehudi.spanFrac * yehudi.chordFrac]`, where `S_base` is S minus the raked-tip area.           |
| `wing.sweepDeg`         | Published quarter-chord sweep. For the F-16 only the leading-edge sweep (40 deg) is published, so `tan(sweep_c/4) = tan(40 deg) - (4/AR)(0.25)(1-taper)/(1+taper)`. |
| `cruise.airspeed`       | cruise Mach x speed of sound, ISA: `a = 340.29 * sqrt(T/288.15)` (T from the standard atmosphere at the cruise altitude).                                           |
| `cruise.alphaDeg`       | Estimate: `alpha = CL/CLalpha + alpha_0L + 0.45 * washout`, with `CL = W/(q S)` and `CLalpha` from the DATCOM/Helmbold formula (below). Retune against the solver.  |
| `approach`              | Typical final-approach speed at sea level; alpha 7 to 8 deg (the lessons deploy flaps separately). The F-16 uses 12 deg, as real F-16 approaches do.                |
| `typicalCruiseMassKg`   | About 85 % of MTOW for airliners (estimate); about 75 to 86 % for light aircraft and the glider; the published "normal loaded" mass for the F-16.                   |

Helmbold / DATCOM lift-curve slope (per radian), with Prandtl-Glauert compressibility
(`beta^2 = 1 - M^2`; at M = 0 it reduces to the incompressible form):

```
CLalpha = 2 pi A / ( 2 + sqrt( 4 + A^2 beta^2 (1 + tan^2(Lambda_half) / beta^2) ) )
```

`alpha_0L` is the thin-airfoil zero-lift angle of the NACA 4-digit mean line, integrated
numerically (about -2 deg for a 2 % camber section). Aspect ratio A uses the published
overall span.

## Published figures

| Preset       | Overall span (m)                             | Reference area (m2)                                                                | Quarter-chord sweep (deg)            | MTOW (kg)                          | Cruise                                    |
| ------------ | -------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------- | ----------------------------------------- |
| `b747-400`   | 64.44 [1][2]                                 | 525 (5,650 sq ft) [3]; some sources: 541 [2]                                       | 37.5 [4]                             | 396,890 (875,000 lb) [1][3]        | Mach 0.85 at 35,000 ft [3]                |
| `b747-8`     | 68.40 (224 ft 7 in) [5]                      | 554 (5,960 sq ft) [5]                                                              | 37.5 (basic 747 sweep) [4][5]        | 442,000 (975,000 lb) [5]           | Mach 0.855 [5]                            |
| `b737-800`   | 35.79 with winglets, 34.32 without [6]       | 124.6 (1,341 sq ft) [6][7]                                                         | 25 (estimate from memory, see below) | 79,016 (174,200 lb) [6]            | Mach 0.785 typical; 0.82 max [6]          |
| `b737-max8`  | 35.90 to 35.92 (about 117 ft 10 in) [9]      | 124.6 (same wing as NG, estimate)                                                  | 25 (as 737-800)                      | 82,191 [9] (Wikipedia: 82,600) [8] | about Mach 0.79 (estimate)                |
| `b787-9`     | 60.12 (197 ft 3 in) [10][11]                 | 377 (4,058 sq ft) [10][11]                                                         | 32 [12] (32.2 in design papers)      | 254,011 (560,000 lb) [10][12]      | Mach 0.85 [10][12]; ceiling 13,100 m [10] |
| `a320neo`    | 35.80 [13] (34.1 for the ceo with fences)    | 122.6 (commonly quoted A320-family figure; not confirmed in a primary source) [14] | 25 [14]                              | 79,000 [13][15]                    | Mach 0.78 [13]                            |
| `a380-800`   | 79.75 [16][17]                               | 845 [16][17]                                                                       | 33.5 [16][17]                        | 575,000 [17]                       | Mach 0.85 [16][17]                        |
| `cessna-172` | 11.00 (36 ft 1 in) [18]                      | 16.2 (174 sq ft) [18]                                                              | 0 [18]                               | 1,157 (2,550 lb) [18]              | 122 kt TAS at about 8,000 ft [18]         |
| `glider-18m` | 18.00 [19]                                   | 10.5 [19]                                                                          | about 0                              | 600 with water ballast [19]        | best glide ratio 50 [19]                  |
| `f16`        | 9.45 (31 ft 0 in; 9.96 m with missiles) [20] | 27.87 (300 sq ft) [20][21]                                                         | 40 leading edge [21]; 32.7 derived   | 19,190 (42,300 lb) [20]            | Mach 0.85 at 9 km: estimate               |

Other published figures used:

| Preset       | Figure                                                                                                                                                        | Source       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `b747-400`   | Winglet height 6 ft (1.8 m); the -400 span is about 5 m wider than the earlier 747s' 59.6 m.                                                                  | [1]          |
| `b737-800`   | Blended winglet about 8 ft (2.4 m) tall.                                                                                                                      | [7]          |
| `b737-max8`  | Split-tip ("Advanced Technology") winglet 9 ft 6 in (2.9 m) total height; about 1 to 1.5 % fuel burn benefit; keeps ICAO Code C gate.                         | [8]          |
| `b787-9`     | Wing aspect ratio 9.6; raked wingtips; ceiling 43,100 ft.                                                                                                     | [10][12]     |
| `a320neo`    | Sharklets about 2.4 m (Airbus) / 2.5 m (Wikipedia) tall; up to 3.5 % fuel burn reduction on flights over 2,800 km; about 200 kg each pair; add 1.7 m to span. | [13][14][22] |
| `a380-800`   | Wing flexes upward by more than 4 m at take-off; tip fences project above and below the tip; aspect ratio about 7.5 (79.75^2 / 845).                          | [16][17]     |
| `cessna-172` | Section: NACA 2412 (modified); aspect ratio 7.32; stall speed 47 kt flaps down; service ceiling 13,500 ft; more than 44,000 built.                            | [18]         |
| `glider-18m` | ASG 29 with 18 m wings: aspect ratio 30.4 to 30.9; empty 280 kg; water ballast 202 kg; sink 0.47 m/s; max speed 270 km/h.                                     | [19]         |
| `f16`        | NACA 64A204 section; 40 deg leading-edge sweep; cropped delta blended into the fuselage; normal loaded mass 26,463 lb (12,003 kg).                            | [20][21]     |

## Sources

1. https://en.wikipedia.org/wiki/Boeing_747-400 (MTOW 875,000 lb; 6 ft winglets; span stretched over the Classic 747)
2. https://planefyi.com/aircraft/boeing-747-400/ (64.44 m span; area quoted as 541.2 m2 / 5,825 sq ft)
3. https://aerospaceweb.org/aircraft/jetliner/b747 (wing area 5,650 sq ft = 524.9 m2; MTOW 396,890 kg; cruise 565 mph at 35,000 ft)
4. https://en.wikipedia.org/wiki/Boeing_747 (37.5 degree wing sweep, Mach 0.85 cruise)
5. https://en.wikipedia.org/wiki/Boeing_747-8 (68.40 m span; 554 m2; 975,000 lb; Mach 0.855; raked tips)
6. https://en.wikipedia.org/wiki/Boeing_737_Next_Generation (737-800: 35.79 m / 34.32 m; 124.6 m2; 79,016 kg; Mach 0.82)
7. https://qantas.com/au/en/qantas-experience/onboard/seat-maps/boeing-737-800.html and https://dimensions.com/element/boeing-737-800 (124.6 m2 / 1,341 sq ft; eight-foot blended winglets)
8. https://en.wikipedia.org/wiki/Boeing_737_MAX (split-tip winglet, 2.90 m, 1 to 1.5 % fuel burn, Code C)
9. https://aerocorner.com/aircraft/boeing-737-max-8/ and https://www.turkishairlines.com/en-bh/flights/fly-different/boeing-B737-MAX8-narrow-body/ (span 35.90 to 35.92 m; MTOW 82,190 kg)
10. https://aeropedia.com.au/content/boeing-787-9-dreamliner/ (60.12 m; 377 m2; 254,011 kg; Mach 0.85; ceiling 13,100 m)
11. https://qantas.com/ar/en/qantas-experience/onboard/seat-maps/boeing-787-9.html (span and area, cross-check)
12. https://en.wikipedia.org/wiki/Boeing_787_Dreamliner (aspect ratio 9.6; sweep 32 degrees; Mach 0.85)
13. https://en.wikipedia.org/wiki/Airbus_A320neo_family (35.80 m; 79 t; Mach 0.78; sharklets, 3.5 %, 200 kg)
14. https://en.wikipedia.org/wiki/Airbus_A320_family (25 degree sweep; 122.6 m2 wing area is the commonly quoted A320 family figure)
15. https://aerocorner.com/aircraft/airbus-a320neo/ (35.80 m; 79,000 kg)
16. https://www.airbus.com/sites/g/files/jlcbta136/files/2022-01/EN-Airbus-A380-Facts-and-Figures-January-2022.pdf (845 m2; 79.8 m; 33.5 degrees; Mach 0.85; wing flexes 4 m)
17. https://en.wikipedia.org/wiki/Airbus_A380 (79.75 m; 575 t; aspect ratio; wingtip fences)
18. https://en.wikipedia.org/wiki/Cessna_172 (172S/R data)
19. https://en.wikipedia.org/wiki/Schleicher_ASG_29 (18 m wings)
20. https://www.f-16.net/f-16_versions_article9.html (F-16C Block 50/52: 31 ft wingspan, 300 sq ft, weights)
21. https://en.wikipedia.org/wiki/General_Dynamics_F-16_Fighting_Falcon (NACA 64A204; 40 degree leading edge; cropped delta)
22. https://skybrary.aero/aircraft/a320 (sharklet height 2.4 m)

## Estimates (not published; chosen for plausibility)

These values are **estimates** and are the first things to retune if the solver's results
disagree with real life:

- **Taper ratio** of every airliner (0.22 to 0.28), the Cessna (0.72), glider (0.33). The F-16's
  0.227 is a commonly quoted value, but was not re-checked.
- **Inboard trailing-edge extension (yehudi)** for every airliner: `spanFrac` 0.33 to 0.35,
  `chordFrac` 0.35 to 0.45.
- **Washout** (3 to 3.5 deg for airliners, 2 deg for the light aircraft and glider, 0 for the F-16),
  and **dihedral** (7 deg 747, 6 deg 737, 5 to 5.5 deg A320/787/A380, 1.7 deg Cessna 172, 3 deg glider, 0 F-16).
- **Airfoil stand-ins**: each real wing uses several different sections along the span; the preset
  uses one NACA 4-digit with a representative mean thickness (airliners 10.5 to 11.2 %, camber 1.5 to
  2.0 %, max camber 45 to 50 % chord). The Cessna uses NACA 2412 (published); the F-16 uses a 4 %
  thick, nearly symmetric section (the real section is NACA 64A204).
- **`supercritical`**: `true` for the 747-8, 737 family, 787, A320neo and A380 (modern designs);
  `false` for the 747-400 (older conventional section), Cessna, glider and F-16.
- **Tip-device sizes and angles**: the 747-400 winglet cant (29 deg) is from memory and not
  re-checked; the 737-800 and A320neo blended-winglet cants (17 deg) and the MAX split-winglet cant
  (19 deg) are chosen so base span + `2 h sin(cant)` reproduces the published overall span. The 747-8
  (6.5 %) and 787-9 (6 %) raked-tip extensions are guesses (about 2.1 m and 1.7 m per side). The A380
  fence height uses the default (4 % of semispan, about 1.6 m).
- **Base wing of the 737 MAX 8**: same as the 737-800 (the MAX kept the Next Generation planform).
  The MAX reference area of 124.6 m2 is therefore an inference, not a quoted figure.
- **Flap geometry** (chord 0.25 to 0.3, span 0.5 to 0.7 of the semispan).
- **Typical cruise mass**: about 85 % of MTOW for the airliners; 1,000 kg for the Cessna 172;
  450 kg for the glider (pilot, no water); 12,000 kg for the F-16 (published "normal loaded").
- **Cruise altitudes**: airliners 10,668 m (35,000 ft), 11,000 m or 11,900 m; the F-16 at 9,000 m,
  the Cessna at 2,438 m (8,000 ft), the glider at 1,500 m.
- **Cruise angle of attack** for every preset (see the derivation above). Real aircraft also get
  lift from the fuselage and tail and have wing incidence relative to the fuselage, so the
  wing-alone angle from the tunnel differs from the cockpit pitch angle.
- **Approach speed** (about Vref+5 kt at typical landing mass) for every preset.
- **Quarter-chord sweeps** for the 737 (25 deg), 787-9 (32 deg) and A320neo (25 deg) are the figures
  commonly quoted by the manufacturers and Wikipedia; they were not confirmed in a primary
  document within this research pass.

## Not modelled

Wing-mounted engines and pylons, the fuselage, the horizontal tail, the Cessna's support strut, wingtip
missiles on the F-16, the glider's winglets (if fitted), and leading-edge extension strakes. The tunnel wing runs through to the
centreline, so the reference area includes the portion that sits inside the fuselage, as published
reference areas do.
