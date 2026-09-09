// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource.ts';
import * as GraderModelsAPI from './grader-models.ts';
import {
  GraderInputs,
  GraderModels,
  LabelModelGrader,
  MultiGrader,
  PythonGrader,
  ScoreModelGrader,
  StringCheckGrader,
  TextSimilarityGrader,
} from './grader-models.ts';

export class Graders extends APIResource {
  graderModels: GraderModelsAPI.GraderModels = new GraderModelsAPI.GraderModels(this._client);
}

Graders.GraderModels = GraderModels;

export declare namespace Graders {
  export {
    GraderModels as GraderModels,
    type GraderInputs as GraderInputs,
    type LabelModelGrader as LabelModelGrader,
    type MultiGrader as MultiGrader,
    type PythonGrader as PythonGrader,
    type ScoreModelGrader as ScoreModelGrader,
    type StringCheckGrader as StringCheckGrader,
    type TextSimilarityGrader as TextSimilarityGrader,
  };
}
