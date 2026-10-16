"""Turn a .syx into a sendmidi program file: one SysEx message per line, a relative delay between them."""
import sys
src, dev, gap, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
d=open(src,'rb').read(); lines=[f'dev "{dev}"','hex']; n=0; i=0
while i<len(d):
    assert d[i]==0xF0; j=d.index(0xF7,i)
    lines.append('syx '+d[i+1:j].hex(' ')); lines.append('+'+gap); n+=1; i=j+1
open(out,'w').write('\n'.join(lines)+'\n'); print(n,'messages ->',out)
