// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource.ts';
import { APIPromise } from '../../core/api-promise.ts';
import { buildHeaders } from '../../internal/headers.ts';
import { RequestOptions } from '../../internal/request-options.ts';
import { path } from '../../internal/utils/path.ts';

export class Content extends APIResource {
  /**
   * Download a skill zip bundle by its ID.
   */
  retrieve(skillID: string, options?: RequestOptions): APIPromise<Response> {
    return this._client.get(path`/skills/${skillID}/content`, {
      ...options,
      headers: buildHeaders([{ Accept: 'application/binary' }, options?.headers]),
      __security: { bearerAuth: true },
      __binaryResponse: true,
    });
  }
}
