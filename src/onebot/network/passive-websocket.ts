import { IOB11NetworkAdapter, OB11EmitEventContent } from './index';
import urlParse from 'url';
import { WebSocket, WebSocketServer } from 'ws';
import { Mutex } from 'async-mutex';
import { OB11Response } from '../action/OB11Response';
import { ActionName } from '../action/types';
import { NapCatCore } from '@/core';
import { LogWrapper } from '@/common/log';
import { OB11HeartbeatEvent } from '../event/meta/OB11HeartbeatEvent';
import { IncomingMessage } from 'http';
import { ActionMap } from '@/onebot/action';
import { LifeCycleSubType, OB11LifeCycleEvent } from '../event/meta/OB11LifeCycleEvent';

export class OB11PassiveWebSocketAdapter implements IOB11NetworkAdapter {
    wsServer: WebSocketServer;
    wsClients: WebSocket[] = [];
    wsClientsMutex = new Mutex();
    isOpen: boolean = false;
    hasBeenClosed: boolean = false;
    heartbeatInterval: number = 0;
    core: NapCatCore;
    logger: LogWrapper;
    private heartbeatIntervalId: NodeJS.Timeout | null = null;
    wsClientWithEvent: WebSocket[] = [];

    constructor(
        ip: string,
        port: number,
        heartbeatInterval: number,
        token: string,
        core: NapCatCore,
        public actions: ActionMap,
    ) {
        this.core = core;
        this.logger = core.context.logger;

        this.heartbeatInterval = heartbeatInterval;
        this.wsServer = new WebSocketServer({
            port: port,
            host: ip,
            maxPayload: 1024 * 1024 * 1024,
        });
        this.wsServer.on('connection', async (wsClient, wsReq) => {
            if (!this.isOpen) {
                wsClient.close();
                return;
            }
            //鉴权
            this.authorize(token, wsClient, wsReq);
            const paramUrl = wsReq.url?.indexOf('?') !== -1 ? wsReq.url?.substring(0, wsReq.url?.indexOf('?')) : wsReq.url;
            const isApiConnect = paramUrl === '/api' || paramUrl === '/api/';
            if (!isApiConnect) {
                this.connectEvent(core, wsClient);
            }

            wsClient.on('error', (err) => this.logger.log('[OneBot] [WebSocket Server] Client Error:', err.message));
            wsClient.on('message', (message) => {
                this.handleMessage(wsClient, message).then().catch(this.logger.logError.bind(this.logger));
            });
            wsClient.on('ping', () => {
                wsClient.pong();
            });
            wsClient.on('pong', () => {
                //this.logger.logDebug('[OneBot] [WebSocket Server] Pong received');
            });
            wsClient.once('close', () => {
                this.wsClientsMutex.runExclusive(async () => {
                    const NormolIndex = this.wsClients.indexOf(wsClient);
                    if (NormolIndex !== -1) {
                        this.wsClients.splice(NormolIndex, 1);
                    }
                    const EventIndex = this.wsClientWithEvent.indexOf(wsClient);
                    if (EventIndex !== -1) {
                        this.wsClientWithEvent.splice(EventIndex, 1);
                    }

                });
            });
            await this.wsClientsMutex.runExclusive(async () => {
                if (!isApiConnect) {
                    this.wsClientWithEvent.push(wsClient);
                }
                this.wsClients.push(wsClient);
            });
        }).on('error', (err) => this.logger.log('[OneBot] [WebSocket Server] Server Error:', err.message));
    }

    connectEvent(core: NapCatCore, wsClient: WebSocket) {
        try {
            this.checkStateAndReply<any>(new OB11LifeCycleEvent(core, LifeCycleSubType.CONNECT), wsClient);
        } catch (e) {
            this.logger.logError.bind(this.logger)('[OneBot] [WebSocket Server] 发送生命周期失败', e);
        }
    }

    onEvent<T extends OB11EmitEventContent>(event: T) {
        this.wsClientsMutex.runExclusive(async () => {
            this.wsClientWithEvent.forEach((wsClient) => {
                wsClient.send(JSON.stringify(event));
            });
        });
    }

    open() {
        if (this.isOpen) {
            this.logger.logError.bind(this.logger)('[OneBot] [WebSocket Server] Cannot open a opened WebSocket server');
            return;
        }
        if (this.hasBeenClosed) {
            this.logger.logError.bind(this.logger)('[OneBot] [WebSocket Server] Cannot open a WebSocket server that has been closed');
            return;
        }
        const addressInfo = this.wsServer.address();
        this.logger.log('[OneBot] [WebSocket Server] Server Started', typeof (addressInfo) === 'string' ? addressInfo : addressInfo?.address + ':' + addressInfo?.port);

        this.isOpen = true;
        this.registerHeartBeat();
    }

    async close() {
        this.isOpen = false;
        this.wsServer.close((err) => {
            if (err) {
                this.logger.logError.bind(this.logger)('[OneBot] [WebSocket Server] Error closing server:', err.message);
            } else {
                this.logger.log.bind(this.logger)('[OneBot] [WebSocket Server] Server Closed');
            }

        });
        if (this.heartbeatIntervalId) {
            clearInterval(this.heartbeatIntervalId);
            this.heartbeatIntervalId = null;
        }
        await this.wsClientsMutex.runExclusive(async () => {
            this.wsClients.forEach((wsClient) => {
                wsClient.close();
            });
            this.wsClients = [];
            this.wsClientWithEvent = [];
        });
    }

    private registerHeartBeat() {
        this.heartbeatIntervalId = setInterval(() => {
            this.wsClientsMutex.runExclusive(async () => {
                this.wsClientWithEvent.forEach((wsClient) => {
                    if (wsClient.readyState === WebSocket.OPEN) {
                        wsClient.send(JSON.stringify(new OB11HeartbeatEvent(this.core, this.heartbeatInterval, this.core.selfInfo.online, true)));
                    }
                });
            });
        }, this.heartbeatInterval);
    }

    private authorize(token: string | undefined, wsClient: WebSocket, wsReq: IncomingMessage) {
        if (!token || token.length == 0) return;//客户端未设置密钥
        const QueryClientToken = urlParse.parse(wsReq?.url || '', true).query.access_token;
        const HeaderClientToken = wsReq.headers.authorization?.split('Bearer ').pop() || '';
        const ClientToken = typeof (QueryClientToken) === 'string' && QueryClientToken !== '' ? QueryClientToken : HeaderClientToken;
        if (ClientToken === token) {
            return;
        }
        wsClient.send(JSON.stringify(OB11Response.res(null, 'failed', 1403, 'token验证失败')));
        wsClient.close();
    }

    private checkStateAndReply<T>(data: T, wsClient: WebSocket) {
        if (wsClient.readyState === WebSocket.OPEN) {
            wsClient.send(JSON.stringify(data));
        }
    }

    private async handleMessage(wsClient: WebSocket, message: any) {
        let receiveData: { action: ActionName, params?: any, echo?: any } = { action: ActionName.Unknown, params: {} };
        let echo = undefined;
        try {
            receiveData = JSON.parse(message.toString());
            echo = receiveData.echo;
            //this.logger.logDebug('收到正向Websocket消息', receiveData);
        } catch (e) {
            this.checkStateAndReply<any>(OB11Response.error('json解析失败,请检查数据格式', 1400, echo), wsClient);
            return;
        }
        receiveData.params = (receiveData?.params) ? receiveData.params : {};//兼容类型验证
        const action = this.actions.get(receiveData.action);
        if (!action) {
            this.logger.logError.bind(this.logger)('[OneBot] [WebSocket Client] 发生错误', '不支持的api ' + receiveData.action);
            this.checkStateAndReply<any>(OB11Response.error('不支持的api ' + receiveData.action, 1404, echo), wsClient);
            return;
        }
        const retdata = await action.websocketHandle(receiveData.params, echo ?? '');
        const packet = Object.assign({}, retdata);
        this.checkStateAndReply<any>(packet, wsClient);
    }
}

