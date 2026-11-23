export {};

const network = require('../../utils/network');
const { types } = require('../../utils/proto');
const { runExclusiveAutomationTask } = require('../automation-lock');
const { getAmbientSendContext, runWithSendContext } = require('./context');
const { logWarn } = require('../../utils/utils');
const { error } = require('./model');

const ROUTES: Record<string, [string, string, string, string?]> = {
    cells: ['homesteadpb.HomesteadService', 'AllCells', 'RanchAllCells'],
    buildings: ['homesteadpb.HomesteadService', 'GetBuildingList', 'RanchGetBuildingList'],
    facility: ['homesteadpb.HomesteadService', 'GetFacilityDetail', 'RanchGetFacilityDetail'],
    activateShed: ['homesteadpb.HomesteadService', 'ActivateFacility', 'RanchActivateFacility'],
    upgrade: ['homesteadpb.HomesteadService', 'UpgradeBuilding', 'RanchUpgradeBuilding'],
    speedUpUpgrade: ['homesteadpb.HomesteadService', 'SpeedUpBuildingUpgrade', 'RanchSpeedUpBuildingUpgrade'],
    completeUpgrade: ['homesteadpb.HomesteadService', 'CompleteBuildingUpgrade', 'RanchCompleteBuildingUpgrade'],
    addGrass: ['homesteadpb.FeedMachineService', 'AddFeed', 'RanchAddFeed'],
    animals: ['animalpb.AnimalService', 'GetRanchDetail', 'RanchGetRanchDetail'],
    enterFriend: ['visitpb.VisitService', 'EnterHomestead', 'RanchEnterHomestead'],
    leaveFriend: ['visitpb.VisitService', 'LeaveHomestead', 'RanchLeaveHomestead'],
    steal: ['animalpb.AnimalService', 'StealProduce', 'RanchStealProduce'],
    place: ['animalpb.AnimalService', 'PlaceAnimal', 'RanchPlaceAnimal'],
    produce: ['animalpb.AnimalService', 'TriggerProduce', 'RanchTriggerProduce'],
    harvest: ['animalpb.AnimalService', 'HarvestRanch', 'RanchHarvestRanch'],
    feed: ['animalpb.AnimalService', 'FeedAnimal', 'RanchFeedAnimal'],
    clean: ['animalpb.RanchService', 'CleanAllRanch', 'RanchCleanAllRanch'],
    stroke: ['animalpb.RanchService', 'StrokeAnimal', 'RanchStrokeAnimal'],
    opTimes: ['animalpb.RanchService', 'GetRanchOpTimes', 'RanchGetRanchOpTimes'],
    release: ['animalpb.AnimalService', 'DonateAnimal', 'RanchDonateAnimal'],
    putMosquito: ['animalpb.RanchService', 'PutHazard', 'RanchPutHazard'],
    bag: ['itempb.ItemService', 'GetBag', 'RanchGetBag'],
    bagTabs: ['itempb.ItemService', 'GetBagTab', 'RanchGetBagTab'],
    lockItems: ['itempb.ItemService', 'LockItems', 'LockItems'],
    unlockItems: ['itempb.ItemService', 'UnlockItems', 'UnlockItems'],
    sell: ['itempb.ItemService', 'Sell', 'RanchSell'],
    useCan: ['itempb.ItemService', 'Use', 'RanchUse'],
    shopProfiles: ['shoppb.ShopService', 'ShopProfiles', 'ShopProfiles'],
    shop: ['shoppb.ShopService', 'ShopInfo', 'ShopInfo'],
    buy: ['shoppb.ShopService', 'BuyGoods', 'BuyGoods'],
    market: ['shoppb.ShopService', 'RotationShopInfo', 'RanchRotationShopInfo'],
    exchange: ['shoppb.ShopService', 'RotationBuyGoods', 'RanchRotationBuyGoods'],
    tasks: ['taskpb.TaskService', 'TaskInfo', 'TaskInfo'],
    claimTask: ['taskpb.TaskService', 'ClaimTaskReward', 'ClaimTaskReward'],
    claimTasks: ['taskpb.TaskService', 'BatchClaimTaskReward', 'BatchClaimTaskReward'],
    reportTask: ['taskpb.TaskService', 'ClientReportProgress', 'ClientReportProgress'],
    book: ['illustratedpb.IllustratedService', 'GetIllustratedListV2', 'RanchGetIllustratedListV2'],
    bookLevels: ['illustratedpb.IllustratedService', 'GetIllustratedLevelListV2', 'GetIllustratedLevelListV2'],
    clearBookNew: ['illustratedpb.IllustratedService', 'ClearNewUnlockedFruitsV2', 'ClearNewUnlockedFruitsV2'],
    weightBook: ['illustratedpb.IllustratedService', 'GetRanchWeightScoreV2', 'RanchGetRanchWeightScoreV2'],
    claimBook: ['illustratedpb.IllustratedService', 'ClaimAllRewardsV2', 'RanchClaimAllRewardsV2'],
    claimWeight: ['illustratedpb.IllustratedService', 'ClaimRanchWeightScoreRewardV2', 'RanchClaimRanchWeightScoreRewardV2'],
    checkShare: ['sharepb.ShareService', 'CheckCanShare', 'CheckCanShare'],
    reportShare: ['sharepb.ShareService', 'ReportShare', 'RanchReportShare'],
    claimShare: ['sharepb.ShareService', 'ClaimShareReward', 'RanchClaimShareReward'],
    activities: ['activitypb.ActivityService', 'List', 'ActivityList'],
    canShop: ['mallpb.MallService', 'GetMallListBySlotType', 'GetMallListBySlotType', 'GetMallListBySlotTypeResponse'],
    buyCan: ['mallpb.MallService', 'Purchase', 'Purchase', 'PurchaseResponse'],
};

async function rpc(route: string, input: any = {}, writing = false): Promise<any> {
    const [service, method, type, replyType] = ROUTES[route];
    const request = types[`${type}Request`];
    const body = request.encode(request.fromObject(input)).finish();
    const context = getAmbientSendContext();
    const reply = await network.sendMsgAsync(`gamepb.${service}`, method, body, {
        beforeSend: () => context?.check(`gamepb.${service}`, method) || null,
        onSent: () => { if (writing) context?.onSent(`gamepb.${service}`, method); },
    });
    return types[replyType || `${type}Reply`].decode(reply.body);
}

function isUnlocked(): boolean {
    return network.getUserState().unlockedSceneIds.includes(2);
}

function inScene(run: (cells: any) => Promise<any>): Promise<any> {
    return runExclusiveAutomationTask('ranch.scene', async () => {
        if (!isUnlocked()) throw error('RANCH_LOCKED', '牧场尚未解锁，请先在游戏中完成开启条件');
        const previous = network.getUserState().globalSceneId;
        const socket = network.getWs();
        let result: any;
        try {
            const scene = previous === 2 ? null : await network.loginGameScene(2);
            const cells = scene ? types.RanchSceneData.decode(scene.big_farm_scene_ext_data).homestead_cells : null;
            result = await run(cells);
            return result;
        } finally {
            if (previous !== 2 && network.getWs() === socket) {
                const restore = () => runWithSendContext({ check: () => null, onSent: () => {} }, () => network.loginGameScene(previous));
                let restoreError: any = null;
                try {
                    // 调用方取消后仍在原队列任务中恢复场景。
                    await restore();
                } catch (firstError: any) {
                    restoreError = firstError;
                    // 连接已经很久没有入站数据（心跳也收不到）时重试只会再拖 20 秒，
                    // 直接判死走重登更快恢复；只有「连接还有心跳、只是单次请求超时」才值得重试。
                    const silenceMs = Number(network.getInboundSilenceMs?.() || 0);
                    if (silenceMs > 15000) {
                        logWarn('牧场', `恢复场景 ${previous} 失败（连接已静默 ${Math.round(silenceMs / 1000)} 秒）：${firstError.message}`, { module: 'ranch', event: 'ranch_scene_restore' });
                    } else {
                        logWarn('牧场', `恢复场景 ${previous} 首次失败，1.5 秒后重试：${firstError.message}`, { module: 'ranch', event: 'ranch_scene_restore_retry' });
                        try {
                            await new Promise(resolve => setTimeout(resolve, 1500));
                            if (network.getWs() !== socket) throw firstError;
                            await restore();
                            restoreError = null;
                        } catch (retryError: any) {
                            restoreError = retryError;
                            logWarn('牧场', `恢复场景 ${previous} 重试仍失败：${retryError.message}`, { module: 'ranch', event: 'ranch_scene_restore' });
                        }
                    }
                }
                if (restoreError) {
                    network.invalidateGameScene('牧场操作结束后场景恢复未确认，需要重新登录');
                    if (result) Object.assign(result, { sceneRestored: false, refreshRequired: true, notice: '场景恢复未确认，账号需重新登录；请刷新核对操作结果' });
                }
            }
        }
    });
}

module.exports = { rpc, inScene, isUnlocked };
