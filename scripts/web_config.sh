#!/usr/bin/env bash
# Shared browser variant selection for build, play and local hosting.
ps2_web_config() {
    local project_root="$1" game_name="$2" default_mode=jspi default_worker=OFF
    [ "$game_name" != ssx3 ] || default_mode=asyncify
    ps2_web_mode="${PS2_WEB_ASYNC:-$default_mode}"
    case "$ps2_web_mode" in
        jspi|asyncify) ;;
        *) echo 'PS2_WEB_ASYNC must be jspi or asyncify' >&2; return 2 ;;
    esac
    if [ "$game_name" = ssx3 ] && [ "$ps2_web_mode" = asyncify ]; then default_worker=ON; fi
    case "${PS2_WEB_WORKER:-$default_worker}" in
        ON|on|TRUE|true|YES|yes|1) ps2_web_worker=ON ;;
        OFF|off|FALSE|false|NO|no|0) ps2_web_worker=OFF ;;
        *) echo 'PS2_WEB_WORKER must be ON or OFF' >&2; return 2 ;;
    esac
    if [ "$ps2_web_worker" = ON ] && [ "$ps2_web_mode" != asyncify ]; then
        echo 'PS2_WEB_WORKER requires PS2_WEB_ASYNC=asyncify' >&2
        return 2
    fi
    ps2_web_suffix=''
    [ "$ps2_web_mode" = jspi ] || ps2_web_suffix=-asyncify
    [ "$ps2_web_worker" = OFF ] || ps2_web_suffix="$ps2_web_suffix-worker"
    ps2_web_out="$project_root/build/web-$game_name$ps2_web_suffix"
    local generated_suffix=''
    [ "$ps2_web_mode" = jspi ] || generated_suffix=-asyncify
    ps2_web_generated="${PS2_GENERATED:-$project_root/generated/$game_name$generated_suffix}"
}
