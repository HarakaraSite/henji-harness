// File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

import { APIResource } from '../../core/resource.ts';
import * as OrganizationAPI from './organization/organization.ts';
import { Organization } from './organization/organization.ts';

export class Admin extends APIResource {
  organization: OrganizationAPI.Organization = new OrganizationAPI.Organization(this._client);
}

Admin.Organization = Organization;

export declare namespace Admin {
  export { Organization as Organization };
}
