/** 2D section benchmarks: NACA experiments (Abbott & von Doenhoff) and NeuralFoil. */
import { describe } from 'vitest';
import { airfoilExperimentChecks, airfoilNeuralFoilChecks } from './checks';
import { runChecks } from './benchmarkTest';

describe('2D sections vs wind-tunnel experiment', () => runChecks(airfoilExperimentChecks()));
describe('2D sections vs NeuralFoil (XFOIL-trained)', () => runChecks(airfoilNeuralFoilChecks()));
