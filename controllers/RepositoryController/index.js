/**
 * @fileoverview Repository Controller exports
 */

import { listRepositories } from './RepositoryQueryController.js';
import {
  addRepository,
  removeRepository,
  modifyRepository,
  enableRepository,
  disableRepository,
} from './RepositoryModificationController.js';

export { listRepositories };
export { addRepository, removeRepository, modifyRepository, enableRepository, disableRepository };

export default {
  listRepositories,
  addRepository,
  removeRepository,
  modifyRepository,
  enableRepository,
  disableRepository,
};
