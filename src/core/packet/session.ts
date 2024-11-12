import { PacketHighwaySession } from "@/core/packet/highway/session";
import { LogWrapper } from "@/common/log";
import { PacketPacker } from "@/core/packet/packer";
import { PacketClient } from "@/core/packet/client/client";
import { NativePacketClient } from "@/core/packet/client/nativeClient";
import { wsPacketClient } from "@/core/packet/client/wsClient";
import { NapCatCore } from "@/core";

type clientPriority = {
    [key: number]: (core: NapCatCore) => PacketClient;
}

const clientPriority: clientPriority = {
    10: (core: NapCatCore) => new NativePacketClient(core),
    1: (core: NapCatCore) => new wsPacketClient(core),
};

export class PacketSession {
    readonly logger: LogWrapper;
    readonly client: PacketClient ;
    readonly packer: PacketPacker;
    readonly highwaySession: PacketHighwaySession;

    constructor(core: NapCatCore) {
        this.logger = core.context.logger;
        this.client = this.newClient(core);
        this.packer = new PacketPacker(this.logger, this.client);
        this.highwaySession = new PacketHighwaySession(this.logger, this.client, this.packer);
    }

    private newClient(core: NapCatCore): PacketClient {
        const prefer = core.configLoader.configData.packetBackend;
        let client: PacketClient | null;
        switch (prefer) {
        case "native":
            this.logger.log("[Core] [Packet] 使用指定的 NativePacketClient 作为后端");
            client = new NativePacketClient(core);
            break;
        case "frida":
            this.logger.log("[Core] [Packet] 使用指定的 FridaPacketClient 作为后端");
            client = new wsPacketClient(core);
            break;
        case "auto":
        case undefined:
            client = this.judgeClient(core);
            break;
        default:
            this.logger.logError(`[Core] [Packet] 未知的PacketBackend ${prefer}，请检查配置文件！`);
            client = null;
        }
        if (!(client && client.check(core))) {
            throw new Error("[Core] [Packet] 无可用的后端，NapCat.Packet将不会加载！");
        }
        return client;
    }

    private judgeClient(core: NapCatCore): PacketClient {
        const sortedClients = Object.entries(clientPriority)
            .map(([priority, clientFactory]) => {
                const client = clientFactory(core);
                const score = +priority * +client.check(core);
                return { client, score };
            })
            .filter(({ score }) => score > 0)
            .sort((a, b) => b.score - a.score);
        const selectedClient = sortedClients[0]?.client;
        if (!selectedClient) {
            throw new Error("[Core] [Packet] 无可用的后端，NapCat.Packet将不会加载！");
        }
        this.logger.log(`[Core] [Packet] 自动选择 ${selectedClient.constructor.name} 作为后端`);
        return selectedClient;
    }
}
