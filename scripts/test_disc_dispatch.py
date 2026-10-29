#!/usr/bin/env python3
"""Exercise the actual disc cache and deferred main-thread fetch entrypoint."""
from pathlib import Path
import argparse, subprocess, tempfile, os, shlex
p=argparse.ArgumentParser();p.add_argument('--source',type=Path,default=Path(__file__).resolve().parents[1]/'host/web.cpp');p.add_argument('--cxx',default=os.environ.get('CXX','c++'));a=p.parse_args()
s=a.source.read_text()
end = s.index('\nvoid wait_while_paused(') if '\nvoid wait_while_paused(' in s else s.index('\nvoid push_audio(')
code = s[s.index('constexpr std::size_t kChunk ='):end]
audio_begin = code.index('struct AudioRing {')
audio_end = code.index('Slot g_slots[', audio_begin)
code = code[:audio_begin] + code[audio_end:]
marker='extern "C" EMSCRIPTEN_KEEPALIVE void ps2web_start_fetch('
if marker in s:
 start=s.index(marker);export=s[start:s.index('\n}',start)+2]
else:
 export='void ps2web_start_fetch(int) { throw std::runtime_error("Baseline has no queued fetch entrypoint"); }'
header=r'''
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <stdexcept>
#include <string>
#define EMSCRIPTEN_KEEPALIVE
void post_main(int);
void post_main(const char *) {}
#define MAIN_THREAD_ASYNC_EM_ASM(code,...) post_main(__VA_ARGS__)
namespace ps2 { void wake_render_thread() {} void halt(const char *s) { throw std::runtime_error(s); } }
void usleep(unsigned) {}
void emscripten_futex_wait(void *,unsigned,double);
void ps2web_fetch(const char *,double,int,void *,std::atomic<std::uint32_t> *);
'''
tests=r'''
struct Pending { int slot; std::uint64_t index; };
std::deque<Pending> pending;
unsigned started=0;
bool fail_next=false,fail_always=false;
void check(bool ok,const char *message) { if(!ok)throw std::runtime_error(message); }
void post_main(int slot) { check(slot>=0&&static_cast<unsigned>(slot)<kSlots,"Invalid queued slot"); pending.push_back({slot,g_slots[slot].index}); }
void ps2web_fetch(const char *,double offset,int size,void *out,std::atomic<std::uint32_t> *state) {
    Slot *slot=nullptr;
    for(auto &s:g_slots)if(&s.state==state)slot=&s;
    check(slot&&slot->state.load()==kLoading,"Fetch must own a loading slot");
    check(offset==static_cast<double>(slot->index*kChunk)&&size==static_cast<int>(slot->size)&&out==slot->data,"Queued fetch metadata changed");
    ++started;
    if(fail_next||fail_always){fail_next=false;state->store(kFailed);return;}
    std::memset(out,static_cast<unsigned char>(slot->index),size);state->store(kReady);
}
void run_one() {
    check(!pending.empty(),"No queued main-thread fetch");
    const auto task=pending.front();pending.pop_front();
    check(g_slots[task.slot].index==task.index,"A queued slot was retagged before dispatch");
    ps2web_start_fetch(task.slot);
}
void emscripten_futex_wait(void *,unsigned,double) { run_one(); }
void reset_cache() {
    check(pending.empty(),"Cannot reset a live request");
    for(auto &s:g_slots){s.state.store(kEmpty);s.attempts=0;}
    g_disc_size=4096ull*kChunk;g_last_chunk=g_run=g_use_clock=0;
}
int main() {
 try {
    reset_cache();Slot *s=want(7);
    check(s&&s->state.load()==kLoading&&s->attempts==1&&pending.size()==1&&started==0,
          "Wanted disc data must queue a main-thread fetch without a renderer service iteration");
    service_disc();check(want(7)==s&&pending.size()==1&&started==0,"Fallback service or cache hit duplicated dispatch");
    fail_next=true;run_one();check(s->state.load()==kFailed&&started==1,"Failure did not settle the slot");
    check(!disc_ready(7ull*kChunk,1)&&s->state.load()==kLoading&&s->attempts==2&&pending.size()==1,"Retry must queue without rendering");
    service_disc();check(pending.size()==1,"Retry was duplicated");run_one();
    std::uint8_t byte=0;check(read_disc(7ull*kChunk+17,&byte,1)==1&&byte==7,"Queued completion returned wrong disc bytes");
    const auto count=started;ps2web_start_fetch(-1);ps2web_start_fetch(kSlots);ps2web_start_fetch(static_cast<int>(s-g_slots));check(started==count,"Invalid or completed slots must not start a request");
    reset_cache();
    for(unsigned i=0;i<kSlots;i++)check(want(100+i)!=nullptr,"Could not reserve a free slot");
    check(pending.size()==kSlots&&want(1000)==nullptr,"Pending request count or ownership is unbounded");
    service_disc();check(pending.size()==kSlots,"Fallback duplicated pending requests");
    while(!pending.empty())run_one();
    for(unsigned i=0;i<kSlots;i++)check(find_slot(100+i)&&find_slot(100+i)->state.load()==kReady,"Dispatch lost or retagged a reserved slot");
    reset_cache();const auto before=started;fail_always=true;bool stopped=false;
    try{read_disc(400ull*kChunk,&byte,1);}catch(const std::runtime_error &e){stopped=std::string(e.what()).find("Could not read the game disc")!=std::string::npos;}
    check(stopped&&started-before==4&&pending.empty(),"Terminal failure must stop after four attempts");
    for(auto &slot:g_slots)delete[] slot.data;
    std::puts("PASS: queued fetch dispatch, deferred execution, deduplication, retry bounds and pending-slot ownership");return 0;
 } catch(const std::exception &e) {std::fprintf(stderr,"FAIL: %s\n",e.what());return 1;}
}
'''
with tempfile.TemporaryDirectory(prefix='ssx3-queued-fetch-') as tmp:
 t=Path(tmp);(t/'test.cpp').write_text(header+code+export+tests)
 subprocess.run(shlex.split(a.cxx)+['-std=c++17','-O0','-pthread',str(t/'test.cpp'),'-o',str(t/'test')],check=True)
 raise SystemExit(subprocess.run([str(t/'test')]).returncode)
