import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARIA2_DNS_RESOLVER,
  ARIA2_FIRELINK_REVISION,
  ARIA2_NETWORK_TARGET_POLICY,
  ARIA2_NETWORK_TARGET_POLICY_DIGEST,
  assertAria2RouteCapabilities,
  assertAria2RouteContract,
  assertAria2RouteSource,
} from './aria2-route-contract.js';

const secureVersion = {
  enabledFeatures: ['Async DNS'],
  firelinkRevision: ARIA2_FIRELINK_REVISION,
  firelinkDnsResolver: ARIA2_DNS_RESOLVER,
  firelinkNetworkTargetPolicies: ['none', ARIA2_NETWORK_TARGET_POLICY],
  firelinkNetworkTargetPolicy: ARIA2_NETWORK_TARGET_POLICY,
  firelinkNetworkTargetPolicyDigest: ARIA2_NETWORK_TARGET_POLICY_DIGEST,
  firelinkNetworkTargetPolicyEnforced: true,
};

test('Aria2 source metadata must identify the Firelink route contract', () => {
  const source = {
    firelinkRouteContract: {
      revision: ARIA2_FIRELINK_REVISION,
      dnsResolver: ARIA2_DNS_RESOLVER,
      networkTargetPolicy: ARIA2_NETWORK_TARGET_POLICY,
      networkTargetPolicyDigest: ARIA2_NETWORK_TARGET_POLICY_DIGEST,
    },
  };

  assert.doesNotThrow(() => assertAria2RouteSource(source, 'test-target'));
  assert.throws(
    () => assertAria2RouteSource({}, 'test-target'),
    /not a Firelink route-contract build/,
  );
  assert.throws(
    () => assertAria2RouteSource({
      firelinkRouteContract: {
        ...source.firelinkRouteContract,
        networkTargetPolicyDigest: 'sha256:wrong',
      },
    }, 'test-target'),
    /networkTargetPolicyDigest/,
  );
});

test('route capabilities are distinct from the active local-fixture policy', () => {
  assert.doesNotThrow(() => assertAria2RouteCapabilities({
    ...secureVersion,
    firelinkNetworkTargetPolicy: 'none',
    firelinkNetworkTargetPolicyEnforced: false,
  }));
  assert.doesNotThrow(() => assertAria2RouteContract(secureVersion));
  assert.throws(
    () => assertAria2RouteContract({
      ...secureVersion,
      firelinkNetworkTargetPolicy: 'none',
      firelinkNetworkTargetPolicyEnforced: false,
    }),
    /route contract mismatch for firelinkNetworkTargetPolicy/,
  );
});
