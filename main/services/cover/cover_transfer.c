#include "cover_transfer.h"
#include <stdlib.h>
#include <string.h>
static uint32_t get32(const uint8_t *p) {return p[0] | ((uint32_t)p[1]<<8) | ((uint32_t)p[2]<<16) | ((uint32_t)p[3]<<24);}
static void put32(uint8_t *p,uint32_t v) {for(unsigned i=0;i<4;i++)p[i]=(uint8_t)(v>>(8*i));}
uint32_t cover_crc32(const uint8_t *p,size_t n) {
 uint32_t crc=UINT32_MAX;
 for(size_t i=0;i<n;i++){crc^=p[i];for(unsigned bit=0;bit<8;bit++)crc=(crc>>1)^((crc&1)?0xedb88320u:0);}
 return ~crc;
}
void cover_transfer_abort(cover_transfer_t *s,cover_code_t code) {
 free(s->pending);s->pending=NULL;s->code=code;
}
static void expire(cover_transfer_t *s,uint64_t now) {
 if(s->pending && now-s->touched>30000)cover_transfer_abort(s,COVER_TIMEOUT);
}
static bool read_bank(cover_transfer_t *s,int bank,uint32_t *revision,uint32_t *size,uint32_t *crc) {
 uint8_t header[24];uint32_t offset=(uint32_t)bank*COVER_BANK_BYTES;
 if(!s->io.read(s->io.context,offset,header,sizeof(header)) || memcmp(header,"CVR1",4)!=0 ||
    get32(header+20)!=cover_crc32(header,20) || get32(header+16)!=0x314a5047u)return false;
 *revision=get32(header+4);*size=get32(header+8);*crc=get32(header+12);
 if(*size>COVER_MAX_BYTES)return false;
 if(!*size)return *crc==0;
 uint8_t *image=malloc(*size);if(!image)return false;
 bool ok=s->io.read(s->io.context,offset+COVER_DATA_OFFSET,image,*size) &&
   cover_crc32(image,*size)==*crc && s->io.validate(image,*size);
 free(image);return ok;
}
bool cover_transfer_init(cover_transfer_t *s,cover_io_t io) {
 if(!s || !io.read || !io.write || !io.erase || !io.validate)return false;
 *s=(cover_transfer_t){.io=io,.bank=-1};
 for(int bank=0;bank<2;bank++){
  uint32_t revision,size,crc;
  if(read_bank(s,bank,&revision,&size,&crc) && (s->bank<0 || (int32_t)(revision-s->revision)>0)){
   s->bank=bank;s->revision=revision;s->saved_size=size;s->saved_crc=crc;
  }
 }
 return true;
}
static bool save(cover_transfer_t *s,const uint8_t *data,uint32_t size,uint32_t crc) {
 int bank=s->bank==0?1:0;uint32_t base=(uint32_t)bank*COVER_BANK_BYTES;
 if(!s->io.erase(s->io.context,base,COVER_BANK_BYTES))return false;
 if(size){
  if(!s->io.write(s->io.context,base+COVER_DATA_OFFSET,data,size))return false;
  uint8_t *verify=malloc(size);if(!verify)return false;
  bool valid=s->io.read(s->io.context,base+COVER_DATA_OFFSET,verify,size) && cover_crc32(verify,size)==crc;
  free(verify);if(!valid)return false;
 }
 uint8_t header[24];memcpy(header,"CVR1",4);put32(header+4,s->revision+1);
 put32(header+8,size);put32(header+12,crc);put32(header+16,0x314a5047u);put32(header+20,cover_crc32(header,20));
 if(!s->io.write(s->io.context,base,header,sizeof(header)))return false;
 uint8_t verify[24];if(!s->io.read(s->io.context,base,verify,sizeof(verify)) || memcmp(header,verify,sizeof(header)))return false;
 s->bank=bank;s->revision++;s->saved_size=size;s->saved_crc=crc;return true;
}
void cover_transfer_packet(cover_transfer_t *s,const uint8_t *p,size_t n,uint64_t now) {
 expire(s,now);
 if(n<7 || p[0]!='P' || p[1]!=1){s->code=COVER_INVALID;return;}
 uint32_t id=get32(p+3);uint8_t op=p[2];
 if(op==1){
  if(s->pending){s->code=COVER_BUSY;return;}
  if(n!=15 || !id || !get32(p+7) || get32(p+7)>COVER_MAX_BYTES){s->code=COVER_INVALID;return;}
  s->id=id;s->total=get32(p+7);s->expected_crc=get32(p+11);s->received=0;
  s->pending=malloc(s->total);s->touched=now;s->code=s->pending?COVER_RECEIVING:COVER_STORAGE;return;
 }
 if(op==5){
  if(n!=7 || !id){s->code=COVER_INVALID;return;}
  if(s->pending){s->code=COVER_BUSY;return;}
  s->id=id;s->total=0;s->received=0;s->code=save(s,NULL,0,0)?COVER_SAVED:COVER_STORAGE;return;
 }
 if(!s->pending || id!=s->id){s->code=COVER_INVALID;return;}
 if(op==4 && n==7){cover_transfer_abort(s,COVER_CANCELLED);return;}
 if(op==2){
  if(n<12 || n>11+COVER_CHUNK_BYTES || get32(p+7)!=s->received || n-11>s->total-s->received){s->code=COVER_INVALID;return;}
  memcpy(s->pending+s->received,p+11,n-11);s->received+=(uint32_t)n-11;s->touched=now;s->code=COVER_RECEIVING;return;
 }
 if(op!=3 || n!=7 || s->received!=s->total){s->code=COVER_INVALID;return;}
 if(cover_crc32(s->pending,s->total)!=s->expected_crc){cover_transfer_abort(s,COVER_CHECKSUM);return;}
 if(!s->io.validate(s->pending,s->total)){cover_transfer_abort(s,COVER_IMAGE);return;}
 bool saved=save(s,s->pending,s->total,s->expected_crc);
 cover_transfer_abort(s,saved?COVER_SAVED:COVER_STORAGE);
}
void cover_transfer_status(cover_transfer_t *s,uint8_t out[24],uint64_t now) {
 expire(s,now);memset(out,0,24);out[0]=1;out[1]=(uint8_t)s->code;out[2]=(s->saved_size?1:0)|(s->pending?2:0);
 put32(out+4,s->id);put32(out+8,s->received);put32(out+12,s->total);put32(out+16,s->revision);put32(out+20,COVER_MAX_BYTES);
}
bool cover_transfer_copy(cover_transfer_t *s,uint8_t **data,size_t *size) {
 if(!s->saved_size)return false;
 uint8_t *copy=malloc(s->saved_size);if(!copy)return false;
 if(!s->io.read(s->io.context,(uint32_t)s->bank*COVER_BANK_BYTES+COVER_DATA_OFFSET,copy,s->saved_size) ||
   cover_crc32(copy,s->saved_size)!=s->saved_crc){free(copy);return false;}
 *data=copy;*size=s->saved_size;return true;
}
