#include "cover_jpeg.h"
#include "cover_transfer.h"
#include "src/libs/tjpgd/tjpgd.h"
#include <stdlib.h>
typedef struct {const uint8_t *data;size_t size,offset;uint16_t *pixels;} stream_t;
static size_t input(JDEC *decoder,uint8_t *out,size_t count) {
 stream_t *s=decoder->device;size_t available=s->size-s->offset;if(count>available)count=available;
 if(out)memcpy(out,s->data+s->offset,count);
 s->offset+=count;
 return count;
}
static int output(JDEC *decoder,void *data,JRECT *rect) {
 stream_t *s=decoder->device;const uint8_t *rgb=data;
 for(unsigned y=rect->top;y<=rect->bottom;y++)for(unsigned x=rect->left;x<=rect->right;x++){
  if(x>=360 || y>=360)return 0;
  if(s->pixels)s->pixels[y*360+x]=(uint16_t)((rgb[0]>>3)<<11 | (rgb[1]>>2)<<5 | (rgb[2]>>3));
  rgb+=3;
 }
 return 1;
}
bool cover_jpeg_decode(const uint8_t *data,size_t size,uint16_t *pixels) {
 if(!data || size<4 || size>COVER_MAX_BYTES || data[0]!=255 || data[1]!=216 || data[size-2]!=255 || data[size-1]!=217)return false;
 void *work=malloc(4096);if(!work)return false;
 stream_t stream={.data=data,.size=size,.pixels=pixels};JDEC decoder;
 bool valid=jd_prepare(&decoder,input,work,4096,&stream)==JDR_OK && decoder.width==360 && decoder.height==360 &&
   jd_decomp(&decoder,output,0)==JDR_OK;
 free(work);return valid;
}
