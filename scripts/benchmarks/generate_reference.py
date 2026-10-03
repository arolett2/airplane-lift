"""
Generate the NUMERICAL reference fixtures for the physics benchmarks.

    python scripts/benchmarks/generate_reference.py

Run it from the repository root in a Python environment that has `neuralfoil`, `aerosandbox`
and `optvl` installed (an isolated virtual environment is recommended, e.g.
`uv venv .venv-bench && uv pip install --python .venv-bench neuralfoil aerosandbox optvl`).
It writes, relative to the repository root:

    src/physics/benchmarks/reference/neuralfoil_2d.json   NeuralFoil (XFOIL-trained) polars
    src/physics/benchmarks/reference/vlm_3d.json          AVL (via OptVL) + AeroSandbox VLM

The experimental fixtures (naca_2d_experimental.json, swept_wing_experimental.json,
aircraft_published.json) are hand-entered from the cited reports and are not touched here.

The fixtures are committed so the TypeScript tests never need Python. Re-run only when a
reference tool or a benchmark geometry changes, and say so in the commit message.
"""

from __future__ import annotations

import json
import math
import os
import sys
import tempfile
from importlib.metadata import version
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "src" / "physics" / "benchmarks" / "reference"

# --------------------------------------------------------------------------------------------
# Geometry helpers (mirror src/physics/airfoil/naca.ts and src/physics/wing/geometry.ts)
# --------------------------------------------------------------------------------------------


def naca4_coordinates(m: float, p: float, t: float, n_half: int = 120) -> np.ndarray:
    """NACA 4-digit contour, TE -> upper -> LE -> lower -> TE (Selig order), closed TE
    (thickness coefficient -0.1036, as the app's own geometry uses)."""
    beta = np.linspace(0, math.pi, n_half + 1)
    x = 0.5 * (1 - np.cos(beta))
    yt = 5 * t * (
        0.2969 * np.sqrt(x) - 0.126 * x - 0.3516 * x**2 + 0.2843 * x**3 - 0.1036 * x**4
    )
    if m > 0:
        yc = np.where(x < p, m / p**2 * (2 * p * x - x**2), m / (1 - p) ** 2 * ((1 - 2 * p) + 2 * p * x - x**2))
        dyc = np.where(x < p, 2 * m / p**2 * (p - x), 2 * m / (1 - p) ** 2 * (p - x))
    else:
        yc = np.zeros_like(x)
        dyc = np.zeros_like(x)
    th = np.arctan(dyc)
    xu, yu = x - yt * np.sin(th), yc + yt * np.cos(th)
    xl, yl = x + yt * np.sin(th), yc - yt * np.cos(th)
    upper = np.stack([xu[::-1], yu[::-1]], axis=1)
    lower = np.stack([xl[1:], yl[1:]], axis=1)
    return np.concatenate([upper, lower])


def base_wing_sections(cfg: dict) -> list[dict]:
    """Right-hand base-wing sections exactly as buildWingGeometry builds them (no flaps,
    no tip devices): leading edge, chord, twist (rad) and roll (rad)."""
    semispan = cfg["span"] / 2
    cr = cfg["rootChord"]
    taper = max(0.01, cfg["taperRatio"])
    ct = taper * cr
    tan_sweep = math.tan(math.radians(cfg["sweepDeg"]))
    dih = math.radians(cfg["dihedralDeg"])
    washout = math.radians(cfg["washoutDeg"])
    inc = math.radians(cfg["rootIncidenceDeg"])
    tol = 1e-3 * semispan

    def trap_chord(y: float) -> float:
        return cr + (ct - cr) * (y / semispan)

    def le_x(y: float) -> float:
        return cr / 4 + y * tan_sweep - trap_chord(y) / 4

    yk = min(cfg["yehudi"]["spanFrac"], 0.95) * semispan
    has_yehudi = cfg["yehudi"]["spanFrac"] > 0 and cfg["yehudi"]["chordFrac"] > 0 and yk > tol
    kink_te = le_x(yk) + trap_chord(yk)
    yehudi_root = max(cr, min(cr * (1 + cfg["yehudi"]["chordFrac"]), kink_te + 1.0 * yk))

    def chord_at(y: float) -> float:
        if has_yehudi and y < yk:
            return yehudi_root + (trap_chord(yk) - yehudi_root) * (y / yk)
        return trap_chord(y)

    stations = [0.0, semispan]
    if has_yehudi:
        stations.append(yk)
    stations.sort()
    return [
        {
            "le": [le_x(y), y, y * math.tan(dih)],
            "chord": chord_at(y),
            "twist": inc - washout * (y / semispan),
            "roll": dih,
        }
        for y in stations
    ]


def refined_sections(cfg: dict, pieces: int = 8) -> list[dict]:
    """The sections with every segment split into `pieces`, everything interpolated linearly in
    span. The app interpolates twist linearly in y between sections; AVL instead interpolates
    chord * incidence (a ruled loft), which on a tapered wing with washout changes the twist
    distribution itself (3 deg washout, taper 0.4: CL at alpha 0 differs by 35 %). Dense sections
    make both codes see the same twist, so the comparison tests the lattice alone. (AVL needs
    its spanwise vortices set on the SURFACE line for this: per-section counts of one vortex per
    interval gave e > 1 on a planar wing.)"""
    secs = base_wing_sections(cfg)
    out = [secs[0]]
    for a, b in zip(secs[:-1], secs[1:]):
        for k in range(1, pieces + 1):
            f = k / pieces
            out.append(
                {
                    "le": [a["le"][i] + f * (b["le"][i] - a["le"][i]) for i in range(3)],
                    "chord": a["chord"] + f * (b["chord"] - a["chord"]),
                    "twist": a["twist"] + f * (b["twist"] - a["twist"]),
                    "roll": a["roll"],
                }
            )
    return out


def reference_quantities(cfg: dict) -> dict:
    cr, taper, b = cfg["rootChord"], max(0.01, cfg["taperRatio"]), cfg["span"]
    s = b * cr * (1 + taper) / 2
    mac = (2 / 3) * cr * (1 + taper + taper**2) / (1 + taper)
    return {"S": s, "b": b, "mac": mac, "AR": b * b / s}


def wing_config(span, root_chord, taper, sweep, airfoil, dihedral=0.0, washout=0.0, yehudi=None):
    return {
        "span": span,
        "rootChord": root_chord,
        "taperRatio": taper,
        "sweepDeg": sweep,
        "dihedralDeg": dihedral,
        "rootIncidenceDeg": 0.0,
        "washoutDeg": washout,
        "yehudi": yehudi or {"spanFrac": 0.0, "chordFrac": 0.0},
        "airfoil": airfoil,
    }


NACA0012 = {"camber": 0.0, "camberPos": 0.4, "thickness": 0.12}

# The benchmark wings. Reference area / span / MAC are those of buildWingGeometry (trapezoid).
WINGS = {
    "rect-ar6": {
        "label": "Rectangular, AR 6, NACA 0012",
        "config": wing_config(6.0, 1.0, 1.0, 0.0, NACA0012),
    },
    "taper-ar8": {
        "label": "Tapered 0.4, unswept c/4, AR 8, NACA 0012",
        "config": wing_config(8.0, 2.0 / 1.4, 0.4, 0.0, NACA0012),
    },
    "swept35-ar6": {
        "label": "35 deg c/4 sweep, taper 0.4, AR 6, NACA 0012",
        "config": wing_config(6.0, 2.0 / 1.4, 0.4, 35.0, NACA0012),
    },
    "b737-800-wing": {
        "label": "737-800 preset base wing (no winglet): AR 10.3, 25 deg, yehudi, 6 deg dihedral, 3 deg washout",
        # Copied from src/state/presets.ts (b737-800); the benchmark test re-checks equality.
        "config": wing_config(
            34.4,
            5.2,
            0.28,
            25.0,
            {"camber": 0.018, "camberPos": 0.45, "thickness": 0.11},
            dihedral=6.0,
            washout=3.0,
            yehudi={"spanFrac": 0.33, "chordFrac": 0.35},
        ),
    },
}

ALPHAS_DEG = [0.0, 2.0, 4.0]

# --------------------------------------------------------------------------------------------
# AVL (OptVL)
# --------------------------------------------------------------------------------------------


def write_avl_file(path: Path, cfg: dict, nchord: int, nspan: int, mach: float) -> None:
    ref = reference_quantities(cfg)
    a = cfg["airfoil"]
    coords = naca4_coordinates(a["camber"], a["camberPos"], a["thickness"], 60)
    lines = [
        "benchmark wing",
        f"{mach:.4f}",
        "0 0 0.0",
        f"{ref['S']:.8f} {ref['mac']:.8f} {ref['b']:.8f}",
        f"{cfg['rootChord'] / 4:.8f} 0.0 0.0",
        "0.0",
        "SURFACE",
        "Wing",
        f"{nchord} 1.0 {nspan} 1.0",
        "YDUPLICATE",
        "0.0",
    ]
    for sec in refined_sections(cfg):
        x, y, z = sec["le"]
        lines += [
            "SECTION",
            f"{x:.8f} {y:.8f} {z:.8f} {sec['chord']:.8f} {math.degrees(sec['twist']):.8f}",
            "AIRFOIL",
        ]
        lines += [f"{px:.6f} {py:.6f}" for px, py in coords]
    path.write_text("\n".join(lines) + "\n")


def run_avl(cfg: dict, mach: float, nchord: int = 16, nspan: int = 96) -> dict:
    from optvl import OVLSolver

    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "wing.avl"
        write_avl_file(f, cfg, nchord, nspan, mach)
        cwd = os.getcwd()
        os.chdir(tmp)
        try:
            ovl = OVLSolver(geo_file=str(f))
            ovl.set_parameter("Mach", mach)
            out = []
            for a in ALPHAS_DEG:
                ovl.set_variable("alpha", a)
                ovl.execute_run()
                fr = ovl.get_total_forces()
                out.append(
                    {
                        "alphaDeg": a,
                        "CL": float(fr["CL"]),
                        "CDi": float(fr["CDff"]),
                        "e": float(fr["e"]),
                    }
                )
        finally:
            os.chdir(cwd)
    cla = (out[2]["CL"] - out[0]["CL"]) / math.radians(ALPHAS_DEG[2] - ALPHAS_DEG[0])
    return {"CLalphaPerRad": cla, "points": out}


# --------------------------------------------------------------------------------------------
# AeroSandbox VortexLatticeMethod (second, independent lattice code)
# --------------------------------------------------------------------------------------------


def run_asb_vlm(cfg: dict) -> dict:
    import aerosandbox as asb

    ref = reference_quantities(cfg)
    a = cfg["airfoil"]
    af = asb.Airfoil(name="bench", coordinates=naca4_coordinates(a["camber"], a["camberPos"], a["thickness"], 80))
    xsecs = [
        asb.WingXSec(xyz_le=sec["le"], chord=sec["chord"], twist=math.degrees(sec["twist"]), airfoil=af)
        for sec in refined_sections(cfg)
    ]
    wing = asb.Wing(name="w", symmetric=True, xsecs=xsecs)
    plane = asb.Airplane(
        wings=[wing], s_ref=ref["S"], c_ref=ref["mac"], b_ref=ref["b"], xyz_ref=[cfg["rootChord"] / 4, 0, 0]
    )
    out = []
    for al in ALPHAS_DEG:
        vlm = asb.VortexLatticeMethod(
            airplane=plane,
            op_point=asb.OperatingPoint(velocity=10, alpha=al),
            spanwise_resolution=3,
            chordwise_resolution=12,
        )
        r = vlm.run()
        out.append({"alphaDeg": al, "CL": float(r["CL"]), "CDnearField": float(r["CD"])})
    cla = (out[2]["CL"] - out[0]["CL"]) / math.radians(ALPHAS_DEG[2] - ALPHAS_DEG[0])
    return {"CLalphaPerRad": cla, "points": out}


def generate_vlm() -> dict:
    cases = []
    for key, w in WINGS.items():
        cfg = w["config"]
        machs = [0.0, 0.785] if key == "b737-800-wing" else [0.0]
        for mach in machs:
            fine = run_avl(cfg, mach)
            coarse = run_avl(cfg, mach, nchord=8, nspan=48)
            conv = abs(fine["CLalphaPerRad"] / coarse["CLalphaPerRad"] - 1)
            case = {
                "id": key if mach == 0 else f"{key}-m{mach:g}",
                "label": w["label"] + ("" if mach == 0 else f", Mach {mach:g} (Prandtl-Glauert)"),
                "mach": mach,
                "config": cfg,
                "reference": reference_quantities(cfg),
                "sections": base_wing_sections(cfg),
                "avl": fine,
                "avlMeshConvergence": {
                    "fine": "16 chordwise x 96 spanwise per semispan, both cosine",
                    "coarse": "8 x 48",
                    "CLalphaRelativeChange": conv,
                },
            }
            # AeroSandbox is a second, independent lattice code (not asserted against; reported).
            # It must get the refined sections: on the 737 wing's two-segment loft (yehudi kink,
            # dihedral, camber) AeroSandbox 4.2's own subdivision returned CL_alpha ~ 46/rad.
            if mach == 0:
                case["aerosandbox"] = run_asb_vlm(cfg)
            cases.append(case)
            print(f"{case['id']:24s} AVL CLa={fine['CLalphaPerRad']:.4f}/rad  e={fine['points'][2]['e']:.4f}  mesh dCLa={conv:.2%}")
    return {
        "source": (
            f"AVL 3.x (M. Drela & H. Youngren, MIT) through OptVL {version('optvl')} "
            "(MDO Lab, https://github.com/mdolab/OptVL), Trefftz-plane CDi and e (CDff); "
            f"AeroSandbox {version('aerosandbox')} VortexLatticeMethod (P. Sharpe, "
            "https://github.com/peterdsharpe/AeroSandbox) as a second lattice code, near-field forces. "
            "Geometry: the app's buildWingGeometry sections (thin camber surface, no thickness), "
            "reference area/span/MAC of the trapezoid, wake along +x, Prandtl-Glauert in AVL for Mach > 0."
        ),
        "generator": "scripts/benchmarks/generate_reference.py",
        "alphasDeg": ALPHAS_DEG,
        "cases": cases,
    }


# --------------------------------------------------------------------------------------------
# NeuralFoil
# --------------------------------------------------------------------------------------------

SECTIONS = {
    "0006": {"camber": 0.0, "camberPos": 0.4, "thickness": 0.06},
    "0012": {"camber": 0.0, "camberPos": 0.4, "thickness": 0.12},
    "2412": {"camber": 0.02, "camberPos": 0.4, "thickness": 0.12},
    "4412": {"camber": 0.04, "camberPos": 0.4, "thickness": 0.12},
}
REYNOLDS = [3e6, 6e6, 9e6]
FLAPS = [  # (section, flap chord fraction, deflection deg)
    ("0012", 0.25, 10.0),
    ("0012", 0.25, 20.0),
    ("2412", 0.25, 10.0),
    ("2412", 0.25, 20.0),
]


def polar_summary(alpha: np.ndarray, cl: np.ndarray, cd: np.ndarray, cm: np.ndarray, conf: np.ndarray) -> dict:
    # Linear range: fit cl over alpha in [aL0 - 2, aL0 + 6] found iteratively from a first guess.
    lin = (alpha >= -2) & (alpha <= 4)
    k, c0 = np.polyfit(alpha[lin], cl[lin], 1)
    a0 = -c0 / k
    lin = (alpha >= a0 - 2) & (alpha <= a0 + 6)
    k, c0 = np.polyfit(alpha[lin], cl[lin], 1)
    a0 = -c0 / k
    # First local maximum above the linear range (positive stall).
    i0 = int(np.argmin(np.abs(alpha - (a0 + 4))))
    imax = i0
    for i in range(i0, len(alpha) - 1):
        if cl[i] >= cl[imax]:
            imax = i
        if cl[i + 1] < cl[i] and cl[i] >= cl[imax] - 1e-9 and alpha[i] > a0 + 6:
            # require a real drop of 2 % within the next 3 deg
            j = min(len(alpha) - 1, i + 12)
            if cl[i + 1 : j + 1].max() < cl[i]:
                break
    cm_lin = cm[lin].mean()
    return {
        "liftSlopePerDeg": float(k),
        "alphaZeroLiftDeg": float(a0),
        "clMax": float(cl[imax]),
        "alphaStallDeg": float(alpha[imax]),
        "cdMin": float(cd[(alpha > a0 - 4) & (alpha < a0 + 10)].min()),
        "cmQuarterChord": float(cm_lin),
        "minConfidenceToStall": float(conf[: imax + 1][alpha[: imax + 1] >= a0 - 2].min()),
    }


def generate_neuralfoil() -> dict:
    import aerosandbox as asb

    alpha = np.round(np.arange(-20, 26.0001, 0.25), 4)
    out = []
    for name, p in SECTIONS.items():
        af = asb.Airfoil(name=f"naca{name}", coordinates=naca4_coordinates(p["camber"], p["camberPos"], p["thickness"]))
        for re in REYNOLDS:
            r = af.get_aero_from_neuralfoil(alpha=alpha, Re=re, model_size="xxxlarge", include_360_deg_effects=False)
            s = polar_summary(alpha, r["CL"], r["CD"], r["CM"], r["analysis_confidence"])
            out.append({"section": name, "params": p, "reynolds": re, "flap": None, **s})
            print(f"NF {name} Re={re:.0e}: a={s['liftSlopePerDeg']:.4f}/deg aL0={s['alphaZeroLiftDeg']:.2f} clmax={s['clMax']:.3f}@{s['alphaStallDeg']:.1f} cdmin={s['cdMin']:.5f} cm={s['cmQuarterChord']:.4f} conf={s['minConfidenceToStall']:.2f}")
    for name, cf, defl in FLAPS:
        p = SECTIONS[name]
        af = asb.Airfoil(name=f"naca{name}", coordinates=naca4_coordinates(p["camber"], p["camberPos"], p["thickness"]))
        af = af.add_control_surface(deflection=defl, hinge_point_x=1 - cf)
        re = 6e6
        r = af.get_aero_from_neuralfoil(alpha=alpha, Re=re, model_size="xxxlarge", include_360_deg_effects=False)
        s = polar_summary(alpha, r["CL"], r["CD"], r["CM"], r["analysis_confidence"])
        s["clAtZeroAlpha"] = float(np.interp(0.0, alpha, r["CL"]))
        out.append({"section": name, "params": p, "reynolds": re, "flap": {"chordFrac": cf, "deflectionDeg": defl}, **s})
        print(f"NF {name} flap {cf}/{defl}: aL0={s['alphaZeroLiftDeg']:.2f} cl0={s['clAtZeroAlpha']:.3f} clmax={s['clMax']:.3f} conf={s['minConfidenceToStall']:.2f}")
    return {
        "source": (
            f"NeuralFoil {version('neuralfoil')} (P. Sharpe, https://github.com/peterdsharpe/NeuralFoil), "
            "model 'xxxlarge', a neural-network surrogate trained on XFOIL; n_crit = 9 (free transition, "
            "smooth model), Mach 0, include_360_deg_effects = False. Airfoil contour: the app's NACA "
            "4-digit equations (closed trailing edge). Flaps: AeroSandbox Airfoil.add_control_surface "
            "(plain flap, geometry deflected about the hinge on the camber line), Re = 6e6."
        ),
        "generator": "scripts/benchmarks/generate_reference.py",
        "method": (
            "liftSlope / alphaZeroLift: least-squares line through cl(alpha) for alpha in "
            "[aL0 - 2, aL0 + 6] deg; clMax / alphaStall: first lift peak; cdMin: minimum cd in "
            "[aL0 - 4, aL0 + 10]; cmQuarterChord: mean cm over the linear range."
        ),
        "polars": out,
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    which = sys.argv[1:] or ["neuralfoil", "vlm"]
    if "neuralfoil" in which:
        (OUT / "neuralfoil_2d.json").write_text(json.dumps(generate_neuralfoil(), indent=2) + "\n")
    if "vlm" in which:
        (OUT / "vlm_3d.json").write_text(json.dumps(generate_vlm(), indent=2) + "\n")


if __name__ == "__main__":
    main()
