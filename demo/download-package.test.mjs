import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDownloadPackage, crc32, sha256, sha256Bytes, packageBytes } from './download-package.js';

// Independent ZIP reader for uncompressed test artifacts. Validate both record
// tables and CRCs, not just the signature or a round-trip through the writer.
export function unpackStoreZip(bytes) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength), decoder=new TextDecoder(), end=bytes.length-22;
  assert.equal(view.getUint32(end,true),0x06054b50); assert.equal(view.getUint16(end+20,true),0);
  const count=view.getUint16(end+10,true), centralSize=view.getUint32(end+12,true), centralStart=view.getUint32(end+16,true);
  assert.equal(centralStart+centralSize,end); const files=new Map(); let position=centralStart;
  for(let index=0;index<count;index++) {
    assert.equal(view.getUint32(position,true),0x02014b50);assert.equal(view.getUint16(position+10,true),0);
    const nameLength=view.getUint16(position+28,true),extra=view.getUint16(position+30,true),comment=view.getUint16(position+32,true);
    const name=decoder.decode(bytes.subarray(position+46,position+46+nameLength));
    const offset=view.getUint32(position+42,true),length=view.getUint32(position+24,true),crc=view.getUint32(position+16,true);
    assert.equal(view.getUint32(offset,true),0x04034b50); assert.equal(view.getUint16(offset+8,true),0);
    assert.equal(view.getUint16(offset+6,true),0x800);assert.equal(view.getUint32(offset+22,true),length);
    assert.equal(view.getUint32(offset+14,true),crc);
    const localName=view.getUint16(offset+26,true),localExtra=view.getUint16(offset+28,true);
    assert.equal(decoder.decode(bytes.subarray(offset+30,offset+30+localName)),name);
    const content=bytes.slice(offset+30+localName+localExtra,offset+30+localName+localExtra+length);
    assert.equal(crc32(content),crc);assert.ok(offset+30+localName+localExtra+length<=centralStart);
    assert.equal(files.has(name),false);files.set(name,content);
    position+=46+nameLength+extra+comment;
  }
  assert.equal(position,end); return files;
}

test('STORE ZIP keeps exact binary and Unicode text bytes with standard headers and CRCs',async()=>{
  const binary=Uint8Array.from({length:513},(_,i)=>i%256),text='Tuomas — Åäö\n';
  const bytes=await createDownloadPackage([{name:'model.3dm',data:binary},{name:'notes.txt',data:text},{name:'empty.txt',data:''}],{createdAt:'2026-11-02T17:00:01.000Z'});
  const files=unpackStoreZip(bytes);assert.deepEqual(files.get('model.3dm'),binary);assert.equal(new TextDecoder().decode(files.get('notes.txt')),text);assert.equal(files.get('empty.txt').length,0);
  assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926);
});

test('ZIP filenames reject traversal, collisions and malformed attachments',async()=>{
  for(const name of ['../secret','/absolute','a/../b','a\\b','a//b','a/.','a/..','a\0b','notes.txt.']) await assert.rejects(createDownloadPackage([{name,data:'x'}]),/unsafe filename/);
  await assert.rejects(createDownloadPackage([{name:'A.txt',data:'x'},{name:'a.txt',data:'x'}]),/repeated/);
  await assert.rejects(createDownloadPackage([{name:'x',data:{}}]),/content type/);
  await assert.rejects(createDownloadPackage([]),/attachments/);
  await assert.rejects(createDownloadPackage([{name:'x',data:'x'}],{createdAt:'invalid'}),/valid creation date/);
});

test('SHA-256 fallback matches standard vectors and independent Node digest across block boundaries',async()=>{
  for(const length of [0,1,3,55,56,63,64,65,119,120,128,1025,1000000]) {
    const bytes=Uint8Array.from({length},(_,i)=>(i*17+65)%256),expected=createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha256Bytes(bytes),expected,`fallback length ${length}`);assert.equal(await sha256(bytes),expected);
  }
  assert.equal(sha256Bytes(new TextEncoder().encode('abc')),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('binary attachment conversion copies caller storage and accepts Blob without a secure context',async()=>{
  const input=new Uint8Array([1,2,3]),copy=await packageBytes(input);input[0]=7;assert.deepEqual([...copy],[1,2,3]);
  assert.deepEqual(await packageBytes(new Blob(['hello'])),new TextEncoder().encode('hello'));
});
