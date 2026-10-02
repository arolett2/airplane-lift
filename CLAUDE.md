# Airplane Lift — notes for agents

- Read `docs/ARCHITECTURE.md` first: layers, coordinate frames (Z-up, +x downstream, +y right
  wing), units (SI + radians in physics), and module ownership.
- Contracts live in `src/physics/types.ts`, `src/state/params.ts`, `src/worker/protocol.ts`, and
  in the exported signatures of stub modules. Do not change a contract you do not own. If one
  is wrong, say so in your final report.
- `physics/` stays pure: no DOM, no three.js.
- Quality gate before every commit: `npm run typecheck && npm run lint && npm test`.
  Run `npx prettier --write <your files>`.
- Tests sit next to their code as `*.test.ts`. Physics tests check against known
  aerodynamic results (thin-airfoil theory, elliptic-wing theory), not just "it runs".
- Do not add npm dependencies without being asked.
- Write commit messages in the imperative mood, scoped by module, e.g.
  `physics(vlm): add Trefftz-plane induced drag`.
