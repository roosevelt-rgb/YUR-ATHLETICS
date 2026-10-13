"""Read-only Genesis status. No CAT seed, key export, mutation or ledger query.

Protocol follows D:/dev/yur-os/proto/spine.proto GetAttestationReport.
An unpinned self-signed attestation proves protocol possession, not authority.
"""
from pathlib import Path
import importlib.util,json,secrets,uuid
import grpc
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

TARGET='[::1]:50051'
METHOD='/yur.substrate.v1.GenesisSubstrate/GetAttestationReport'
spec=importlib.util.spec_from_file_location('yur_substrate_wire',Path(__file__).with_name('substrate_wire.py'))
wire=importlib.util.module_from_spec(spec);spec.loader.exec_module(wire)

def verify(response,nonce):
    if len(nonce)!=32 or len(response.enclave_pubkey)!=32 or len(response.ledger_tail_hash)!=48 or len(response.signature)!=64:
        raise ValueError('Invalid attestation shape')
    payload=nonce+response.ledger_height.to_bytes(8,'little')+response.ledger_tail_hash
    Ed25519PublicKey.from_public_bytes(response.enclave_pubkey).verify(response.signature,payload)

def probe(channel_factory=grpc.insecure_channel,nonce_factory=lambda:secrets.token_bytes(32),verify_response=verify):
    nonce=nonce_factory()
    if len(nonce)!=32:raise ValueError('Nonce must be 32 bytes')
    try:
        with channel_factory(TARGET,options=[('grpc.max_receive_message_length',65536)]) as channel:
            call=channel.unary_unary(METHOD,request_serializer=wire.AttestationRequest.SerializeToString,response_deserializer=wire.AttestationResponse.FromString)
            response=call(wire.AttestationRequest(nonce=nonce,trace_id=uuid.uuid4().bytes),timeout=2.5)
        try:verify_response(response,nonce)
        except Exception:
            return {'state':'invalid-attestation','signature_verified':False,'identity_pinned':False,'execution_bound':False,'endpoint':TARGET}
        return {'state':'attested-unpinned','signature_verified':True,'identity_pinned':False,'execution_bound':False,'endpoint':TARGET,'ledger_height':response.ledger_height,'fingerprint':response.ledger_tail_hash.hex()[:16]}
    except grpc.RpcError as failure:
        return {'state':'grpc-unavailable','signature_verified':False,'identity_pinned':False,'execution_bound':False,'endpoint':TARGET,'error':failure.code().name}

if __name__=='__main__':
    try:print(json.dumps({'ok':True,'result':probe()},separators=(',',':')))
    except Exception:print(json.dumps({'ok':False,'error':{'code':'PROBE_UNAVAILABLE','message':'Read-only substrate protocol status could not be checked.'}},separators=(',',':')))
