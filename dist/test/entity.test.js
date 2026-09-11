"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const entity_1 = require("../src/entity");
(0, node_test_1.test)('buildEntityDescriptor builds a full entity: uid, attrs, parents', () => {
    const d = (0, entity_1.buildEntityDescriptor)('Agent', 'aa-bb-cc-dd-ee-ff', { user: { __entity: { type: 'User', id: 'alice@example.com' } } }, [
        { type: 'Org', id: 'reva' },
    ]);
    strict_1.default.deepEqual(d.uid, { type: 'Agent', id: 'aa-bb-cc-dd-ee-ff' });
    strict_1.default.deepEqual(d.attrs, { user: { __entity: { type: 'User', id: 'alice@example.com' } } });
    strict_1.default.deepEqual(d.parents, [{ type: 'Org', id: 'reva' }]);
});
(0, node_test_1.test)('buildEntityDescriptor defaults attrs to {} and parents to [] when omitted', () => {
    const d = (0, entity_1.buildEntityDescriptor)('User', 'alice@example.com');
    strict_1.default.deepEqual(d.attrs, {});
    strict_1.default.deepEqual(d.parents, []);
});
(0, node_test_1.test)('refOf extracts a bare {type, id} pointer from a descriptor', () => {
    const d = (0, entity_1.buildEntityDescriptor)('Agent', 'aa-bb-cc-dd-ee-ff');
    strict_1.default.deepEqual((0, entity_1.refOf)(d), { type: 'Agent', id: 'aa-bb-cc-dd-ee-ff' });
});
(0, node_test_1.test)('entityRef builds a bare {type, id} pointer directly', () => {
    strict_1.default.deepEqual((0, entity_1.entityRef)('User', 'alice@example.com'), { type: 'User', id: 'alice@example.com' });
});
(0, node_test_1.test)('directSpecOf maps attrs and request-local parents without a legacy uid shape', () => {
    const descriptor = (0, entity_1.buildEntityDescriptor)('File', 'repo/a.ts', { name: 'a.ts' }, [
        { type: 'Repository', id: 'repo' },
    ]);
    const spec = (0, entity_1.directSpecOf)(descriptor);
    strict_1.default.deepEqual(spec, {
        type: 'File',
        id: 'repo/a.ts',
        properties: { name: 'a.ts' },
        parents: [{ type: 'Repository', id: 'repo' }],
    });
    strict_1.default.equal('uid' in spec, false);
});
