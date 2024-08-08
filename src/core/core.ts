import { WrapperNodeApi } from "./wrapper/wrapper";
import path from "node:path";
import fs from "node:fs";
import { InstanceContext } from "./wrapper";
import { NTEventChannel } from "@/common/framework/event";

export enum NapCatCoreWorkingEnv {
    Unknown = 0,
    Shell = 1,
    LiteLoader = 2,
}

export function loadQQWrapper(QQVersion: string): WrapperNodeApi {
    let wrapperNodePath = path.resolve(path.dirname(process.execPath), './resources/app/wrapper.node');
    if (!fs.existsSync(wrapperNodePath)) {
        wrapperNodePath = path.join(path.dirname(process.execPath), `resources/app/versions/${QQVersion}/wrapper.node`);
    }
    const nativemodule: any = { exports: {} };
    process.dlopen(nativemodule, wrapperNodePath);
    return nativemodule.exports;
}

export class NapCatCore {
    readonly context: InstanceContext;
    readonly eventChannel: NTEventChannel;

    constructor(context: InstanceContext) {
        this.context = context;
        this.eventChannel = new NTEventChannel(context.wrapper, context.session);
    }

    // Renamed from 'InitDataListener'
    initNapCatCoreListeners() {
        
    }
}