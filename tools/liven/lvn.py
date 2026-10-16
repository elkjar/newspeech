"""LIVEN SysEx container: F0 00 48 04 00 00 <model> <cmd> <type> <7-bit packed payload> F7"""
import sys, zlib
def msgs(d):
    out=[];i=0
    while i<len(d):
        j=d.index(0xF7,i); out.append(d[i+1:j]); i=j+1
    return out
def unpack(p):
    o=bytearray()
    for g in range(0,len(p),8):
        grp=p[g:g+8]; msb=grp[0]
        for k,b in enumerate(grp[1:]): o.append(b|(0x80 if msb>>(6-k)&1 else 0))
    return bytes(o)
def decode(path):
    m=msgs(open(path,'rb').read())
    hdr=m[0][:7]; parts={}
    for x in m: parts.setdefault(x[7],[]).append(unpack(x[8:]))
    return hdr,parts
if __name__=='__main__':
    hdr,parts=decode(sys.argv[1])
    types=sorted(parts)
    start,end=parts[types[0]][0],parts[types[-1]][0]
    body=b''.join(parts[types[1]])
    print('hdr',hdr.hex(),'start',start.hex(),'end',end.hex(),'body',len(body))
    crc=zlib.crc32(body)
    print('crc32(body) LE',crc.to_bytes(4,'little').hex(),'BE',crc.to_bytes(4,'big').hex())
    print('sum32',(sum(body)&0xffffffff).to_bytes(4,'little').hex())
    if len(sys.argv)>2: open(sys.argv[2],'wb').write(body)
