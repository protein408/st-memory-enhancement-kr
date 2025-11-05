// absoluteRefresh.js
import { BASE, DERIVED, EDITOR, SYSTEM, USER } from '../../core/manager.js';
import {  convertOldTablesToNewSheets, executeTableEditActions, getTableEditTag } from "../../index.js";
import JSON5 from '../../utils/json5.min.mjs'
import { updateSystemMessageTableStatus } from "../renderer/tablePushToChat.js";
import { TableTwoStepSummary } from "./separateTableUpdate.js";
import { estimateTokenCount, handleCustomAPIRequest, handleMainAPIRequest } from "../settings/standaloneAPI.js";
import { profile_prompts } from "../../data/profile_prompts.js";
import { Form } from '../../components/formManager.js';
import { refreshRebuildTemplate } from "../settings/userExtensionSetting.js"
import { safeParse } from '../../utils/stringUtil.js';

// 在파싱响应后添加验证
function validateActions(actions) {
    if (!Array.isArray(actions)) {
        console.error('작업 목록은 배열이어야 합니다');
        return false;
    }
    return actions.every(action => {
        // 필수 필드 검사
        if (!action.action || !['insert', 'update', 'delete'].includes(action.action.toLowerCase())) {
            console.error(`잘못된 작업 유형: ${action.action}`);
            return false;
        }
        if (typeof action.tableIndex !== 'number') {
            console.error(`tableIndex는 숫자여야 합니다: ${action.tableIndex}`);
            return false;
        }
        if (action.action !== 'insert' && typeof action.rowIndex !== 'number') {
            console.error(`rowIndex는 숫자여야 합니다: ${action.rowIndex}`);
            return false;
        }
        // data 필드 검사
        if (action.data && typeof action.data === 'object') {
            const invalidKeys = Object.keys(action.data).filter(k => !/^\d+$/.test(k));
            if (invalidKeys.length > 0) {
                console.error(`숫자가 아닌 키 발견: ${invalidKeys.join(', ')}`);
                return false;
            }
        }
        return true;
    });
}

function confirmTheOperationPerformed(content) {
    console.log('content:', content);
    return `
<div class="wide100p padding5 dataBankAttachments">
    <div class="refresh-title-bar">
        <h2 class="refresh-title"> 다음 작업을 확인해주세요 </h2>
        <div>

        </div>
    </div>
    <div id="tableRefresh" class="refresh-scroll-content">
        <div>
            <div class="operation-list-container"> ${content.map(table => {
        return `
<h3 class="operation-list-title">${table.tableName}</h3>
<div class="operation-list">
    <table class="tableDom sheet-table">
        <thead>
            <tr>
                ${table.columns.map(column => `<th>${column}</th>`).join('')}
            </tr>
        </thead>
        <tbody>
            ${table.content.map(row => `
            <tr>
                ${row.map(cell => `<td>${cell}</td>`).join('')}
            </tr>
            `).join('')}
        </tbody>
    </table>
</div>
<hr>
`;
    }).join('')}
            </div>
        </div>
    </div>
</div>

<style>
    .operation-list-title {
        text-align: left;
        margin-top: 10px;
    }
    .operation-list-container {
        display: flex;
        flex-wrap: wrap;
    }
    .operation-list {
        width: 100%;
        max-width: 100%;
        overflow: auto;
    }
</style>
`;
}



/**
 * 테이블 새로고침 유형 선택기 초기화
 * profile_prompts 객체에 따라 동적으로 드롭다운 선택기 옵션 생성
 */
export function initRefreshTypeSelector() {
    const $selector = $('#table_refresh_type_selector');
    if (!$selector.length) return;

    // 清空并重新添加选项
    $selector.empty();

    // 遍历profile_prompts对象，添加选项
    Object.entries(profile_prompts).forEach(([key, value]) => {
        const option = $('<option></option>')
            .attr('value', key)
            .text((() => {
                switch (value.type) {
                    case 'refresh':
                        return '**이전**' + (value.name || key);
                    case 'third_party':
                        return '**Third-party author** ' + (value.name || key);
                    default:
                        return value.name || key;
                }
            })());
        $selector.append(option);
    });

    // 如果没有选项，添加默认选项
    if ($selector.children().length === 0) {
        $selector.append($('<option></option>').attr('value', 'rebuild_base').text('~~~이 옵션이 보인다면 문제가 발생했습니다~~~~'));
    }

    console.log('테이블 새로고침 유형 선택기가 업데이트되었습니다');

    // // 检查现有选项是否与profile_prompts一致
    // let needsUpdate = false;
    // const currentOptions = $selector.find('option').map(function() {
    //     return {
    //         value: $(this).val(),
    //         text: $(this).text()
    //     };
    // }).get();

    // // 检查选项数量是否一致
    // if (currentOptions.length !== Object.keys(profile_prompts).length) {
    //     needsUpdate = true;
    // } else {
    //     // 检查每个选项的值和文本是否一致
    //     Object.entries(profile_prompts).forEach(([key, value]) => {
    //         const currentOption = currentOptions.find(opt => opt.value === key);
    //         if (!currentOption ||
    //             currentOption.text !== ((value.type=='refresh'? '**이전** ':'')+value.name|| key)) {
    //             needsUpdate = true;
    //         }
    //     });
    // }

    // // 不匹配时清空并重新添加选项
    // if (needsUpdate) {
    //     $selector.empty();

    //     // 遍历profile_prompts对象，添加选项
    //     Object.entries(profile_prompts).forEach(([key, value]) => {
    //         const option = $('<option></option>')
    //             .attr('value', key)
    //             .text((value.type=='refresh'? '**旧** ':'')+value.name|| key);
    //         $selector.append(option);
    //     });

    //     // 如果没有选项，添加默认选项
    //     if ($selector.children().length === 0) {
    //         $selector.append($('<option></option>').attr('value', 'rebuild_base').text('~~~看到这个选项说明出问题了~~~~'));
    //     }

    //     console.log('테이블새로고침类型选择器已업데이트');
}



/**
 * 根据选择的새로고침类型获取对应的提示模板并调用rebuildTableActions
 * @param {string} templateName 프롬프트 템플릿 이름
 * @param {string} additionalPrompt 추가 프롬프트 내용
 * @param {boolean} force 강제 새로고침 여부, 확인 대화 상자 표시 안 함
 * @param {boolean} isSilentUpdate 자동 업데이트 여부, 작업 확인 표시 안 함
 * @param {string} chatToBeUsed 사용할 채팅 기록 (비어있으면 최신 채팅 기록 사용)
 */
export async function getPromptAndRebuildTable(templateName = '', additionalPrompt, force, isSilentUpdate = USER.tableBaseSetting.bool_silent_refresh, chatToBeUsed = '') {
    let r = '';
    try {
        r = await rebuildTableActions(force || true, isSilentUpdate, chatToBeUsed);
        return r;
    } catch (error) {
        console.error('요약 실패:', error);
        EDITOR.error(`요약 실패: ${error.message}`);
    }
}

/**
 * 테이블 재생성 완료
 * @param {*} force 是否强制새로고침
 * @param {*} silentUpdate  是否静默업데이트
 * @param chatToBeUsed
 * @returns
 */
export async function rebuildTableActions(force = false, silentUpdate = USER.tableBaseSetting.bool_silent_refresh, chatToBeUsed = '') {
    // #region 表格总结执行
    let r = '';
    if (!SYSTEM.lazy('rebuildTableActions', 1000)) return;

    console.log('전체 테이블 재생성 시작');
    const isUseMainAPI = $('#use_main_api').prop('checked');
    try {
        const { piece } = BASE.getLastSheetsPiece();
        if (!piece) {
            throw new Error('findLastestTableData가 유효한 테이블 데이터를 반환하지 않았습니다');
        }
        const latestTables = BASE.hashSheetsToSheets(piece.hash_sheets).filter(sheet => sheet.enable);
        DERIVED.any.waitingTable = latestTables;
        DERIVED.any.waitingTableIdMap = latestTables.map(table => table.uid);

        const tableJson = latestTables.map((table, index) => ({...table.getReadableJson(), tableIndex: index}));
        const tableJsonText = JSON.stringify(tableJson);

        // 提取表头信息
        const tableHeaders = latestTables.map(table => {
            return {
                tableId: table.uid,
                headers: table.getHeader()
            };
        });
        const tableHeadersText = JSON.stringify(tableHeaders);

        console.log('헤더 데이터 (JSON):', tableHeadersText);
        console.log('정리 - 최신 테이블 데이터:', tableJsonText);

        // 获取最近clear_up_stairs条聊天记录
        const chat = USER.getContext().chat;
        const lastChats = chatToBeUsed === '' ? await getRecentChatHistory(chat,
            USER.tableBaseSetting.clear_up_stairs,
            USER.tableBaseSetting.ignore_user_sent,
            USER.tableBaseSetting.rebuild_token_limit_value
        ) : chatToBeUsed;

        // 构建AI提示
        const select = USER.tableBaseSetting.lastSelectedTemplate ?? "rebuild_base"
        const template = select === "rebuild_base" ? {
            name: "rebuild_base",
            system_prompt: USER.tableBaseSetting.rebuild_default_system_message_template,
            user_prompt_begin: USER.tableBaseSetting.rebuild_default_message_template,
        } : USER.tableBaseSetting.rebuild_message_template_list[select]
        if (!template) {
            console.error('해당하는 프롬프트 템플릿을 찾을 수 없습니다. 설정을 확인해주세요', select, template);
            EDITOR.error('해당하는 프롬프트 템플릿을 찾을 수 없습니다. 설정을 확인해주세요');
            return;
        }
        let systemPrompt = template.system_prompt
        let userPrompt = template.user_prompt_begin;

        let parsedSystemPrompt

        try {
            parsedSystemPrompt = JSON5.parse(systemPrompt)
            console.log('파싱된 systemPrompt:', parsedSystemPrompt);
        } catch (error) {
            console.log("파싱 실패", error)
            parsedSystemPrompt = systemPrompt
        }

        const replacePrompt = (input) => {
            let output = input
            output = output.replace(/\$0/g, tableJsonText);
            output = output.replace(/\$1/g, lastChats);
            output = output.replace(/\$2/g, tableHeadersText);
            output = output.replace(/\$3/g, DERIVED.any.additionalPrompt ?? '');
            return output
        }

        // systemPrompt에서 $0과 $1 필드를 검색하여 $0을 originText로, $1을 lastChats로 대체
        if (typeof parsedSystemPrompt === 'string') {
            parsedSystemPrompt = replacePrompt(parsedSystemPrompt);
        } else {
            parsedSystemPrompt = parsedSystemPrompt.map(mes => ({ ...mes, content: replacePrompt(mes.content) }))
        }


        // userPrompt에서 $0과 $1 필드를 검색하여 $0을 originText로, $1을 lastChats로, $2를 빈 헤더로 대체
        userPrompt = userPrompt.replace(/\$0/g, tableJsonText);
        userPrompt = userPrompt.replace(/\$1/g, lastChats);
        userPrompt = userPrompt.replace(/\$2/g, tableHeadersText);
        userPrompt = userPrompt.replace(/\$3/g, DERIVED.any.additionalPrompt ?? '');

        console.log('systemPrompt:', parsedSystemPrompt);
        // console.log('userPrompt:', userPrompt);

        // 응답 내용 생성
        let rawContent;
        if (isUseMainAPI) {
            try {
                rawContent = await handleMainAPIRequest(parsedSystemPrompt, userPrompt);
                if (rawContent === 'suspended') {
                    EDITOR.info('작업이 취소되었습니다');
                    return
                }
            } catch (error) {
                EDITOR.clear();
                EDITOR.error('주 API 요청 오류: ' , error.message, error);
                console.error('주 API 요청 오류:', error);
            }
        }
        else {
            try {
                rawContent = await handleCustomAPIRequest(parsedSystemPrompt, userPrompt);
                if (rawContent === 'suspended') {
                    EDITOR.clear();
                    EDITOR.info('작업이 취소되었습니다');
                    return
                }
            } catch (error) {
                EDITOR.clear();
                EDITOR.error('사용자 정의 API 요청 오류: ' , error.message, error);
            }
        }
        console.log('rawContent:', rawContent);

        // rawContent가 유효한지 확인
        if (typeof rawContent !== 'string') {
            EDITOR.clear();
            EDITOR.error('API 응답 내용이 유효하지 않아 테이블 처리를 계속할 수 없습니다.');
            console.error('API 응답 내용이 유효하지 않음, rawContent:', rawContent);
            return;
        }

        if (!rawContent.trim()) {
            EDITOR.clear();
            EDITOR.error('빈 API 응답은 일반적으로 API 제한을 위반했음을 나타냅니다.');
            console.error('API 응답 내용이 비어 있음, rawContent:', rawContent);
            return;
        }

        const temp = USER.tableBaseSetting.rebuild_message_template_list[USER.tableBaseSetting.lastSelectedTemplate];
        if (temp && temp.parseType === 'text') {
            showTextPreview(rawContent);
        }

        console.log('응답 내용은 다음과 같습니다:', rawContent);
        let cleanContentTable = null;
        try{
            const parsed = safeParse(rawContent);
            cleanContentTable = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
        }catch (error) {
            console.error('응답 내용을 구문 분석하지 못했습니다:', error);
            EDITOR.clear();
            EDITOR.error('응답 내용을 구문 분석하지 못했습니다. API에서 반환된 내용이 예상 형식을 충족하는지 확인하세요.', error.message, error);
            showErrorTextPreview(rawContent);
            return;
        }
        
        console.log('cleanContent:', cleanContentTable);

        // 테이블 다시 저장
        if (cleanContentTable) {
            try {
                // 데이터 형식 검증
                if (!Array.isArray(cleanContentTable)) {
                    throw new Error("生成的新表格数据不是数组");
                }

                // 如果不是静默更新，显示操作确认
                if (!silentUpdate) {
                    // uniqueActions 내용을 사용자에게 보여주고 계속할지 확인
                    const confirmContent = confirmTheOperationPerformed(cleanContentTable);
                    const tableRefreshPopup = new EDITOR.Popup(confirmContent, EDITOR.POPUP_TYPE.TEXT, '', { okButton: "계속하기", cancelButton: "취소" });
                    EDITOR.clear();
                    await tableRefreshPopup.show();
                    if (!tableRefreshPopup.result) {
                        EDITOR.info('작업이 취소되었습니다');
                        return;
                    }
                }

                // 채팅 기록 업데이트
                const { piece } = USER.getChatPiece()
                if (piece) {
                    for (const index in cleanContentTable) {
                        let sheet;
                        const table = cleanContentTable[index];
                        if (table.tableUid){
                            sheet = BASE.getChatSheet(table.tableUid)
                        }else if(table.tableIndex !== undefined) {
                            const uid = DERIVED.any.waitingTableIdMap[table.tableIndex]
                            sheet = BASE.getChatSheet(uid)
                        }else{
                            const uid = DERIVED.any.waitingTableIdMap[index]
                            sheet = BASE.getChatSheet(uid)
                        }
                        if(!sheet) {
                            console.error(`无法找到表格 ${table.tableName} 对应的sheet`);
                            continue;
                        }
                        const valueSheet = [table.columns, ...table.content].map(row => ['', ...row])
                        sheet.rebuildHashSheetByValueSheet(valueSheet);
                        sheet.save(piece, true)
                    }
                    await USER.getContext().saveChat(); // 等待保存完成
                } else {
                    throw new Error("채팅 기록이 비어 있습니다. 최소한 하나의 채팅 기록이 생긴 후에만 요약해 주세요.");
                }

                BASE.refreshContextView();
                updateSystemMessageTableStatus();
                EDITOR.success('테이블 생성 성공！');
            } catch (error) {
                console.error('테이블 저장 중 오류 발생:', error);
                EDITOR.error(`테이블 생성 실패`, error.message, error);
            }
        } else {
            EDITOR.error("테이블 생성 저장 실패: 내용이 비어 있습니다");
            true
        }

    } catch (e) {
        console.error('rebuildTableActions에서 오류 발생:', e);
        return;
    } finally {

    }
    // #endregion
}

async function showTextPreview(text) {
    const previewHtml = `
        <div>
            <span style="margin-right: 10px;">반환된 요약 결과를 복사하여 사용하세요</span>
        </div>
        <textarea rows="10" style="width: 100%">${text}</textarea>
    `;

    const popup = new EDITOR.Popup(previewHtml, EDITOR.POPUP_TYPE.TEXT, '', { wide: true });
    await popup.show();
}

async function showErrorTextPreview(text) {
    const previewHtml = `
        <div>
            <span style="margin-right: 10px;">이는 스크립트에서 구문 분석할 수 없는 AI가 반환한 정보이므로 중지됩니다</span>
        </div>
        <textarea rows="10" style="width: 100%">${text}</textarea>
    `;

    const popup = new EDITOR.Popup(previewHtml, EDITOR.POPUP_TYPE.TEXT, '', { wide: true });
    await popup.show();
}

export async function rebuildSheets() {
    const container = document.createElement('div');
    console.log('테스트 시작');


    const style = document.createElement('style');
    style.innerHTML = `
        .rebuild-preview-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .rebuild-preview-text {
            display: flex;
            justify-content: left
        }
    `;
    container.appendChild(style);

    // Replace jQuery append with standard DOM methods
    const h3Element = document.createElement('h3');
    h3Element.textContent = '테이블 데이터 재구성';
    container.appendChild(h3Element);

    const previewDiv1 = document.createElement('div');
    previewDiv1.className = 'rebuild-preview-item';
    previewDiv1.innerHTML = `<span>실행 완료 후 확인하시겠습니까?: </span>${USER.tableBaseSetting.bool_silent_refresh ? '아니오' : '예'}`;
    container.appendChild(previewDiv1);

    const previewDiv2 = document.createElement('div');
    previewDiv2.className = 'rebuild-preview-item';
    previewDiv2.innerHTML = `<span>API：</span>${USER.tableBaseSetting.use_main_api ? '주 API 사용' : '대체 API 사용'}`;
    container.appendChild(previewDiv2);

    const hr = document.createElement('hr');
    container.appendChild(hr);

    // 선택자 컨테이너 생성
    const selectorContainer = document.createElement('div');
    container.appendChild(selectorContainer);

    // 프롬프트 템플릿 선택자 추가
    const selectorContent = document.createElement('div');
    selectorContent.innerHTML = `
        <span class="rebuild-preview-text" style="margin-top: 10px">프롬프트 템플릿：</span>
        <select id="rebuild_template_selector" class="rebuild-preview-text text_pole" style="width: 100%">
            <option value="">로딩 중...</option>
        </select>
        <span class="rebuild-preview-text" style="margin-top: 10px">템플릿 정보：</span>
        <div id="rebuild_template_info" class="rebuild-preview-text" style="margin-top: 10px"></div>
        <span class="rebuild-preview-text" style="margin-top: 10px">기타 요구사항：</span>
        <textarea id="rebuild_additional_prompt" class="rebuild-preview-text text_pole" style="width: 100%; height: 80px;"></textarea>
    `;
    selectorContainer.appendChild(selectorContent);

    // 선택기 옵션 초기화
    const $selector = $(selectorContent.querySelector('#rebuild_template_selector'))
    const $templateInfo = $(selectorContent.querySelector('#rebuild_template_info'))
    const $additionalPrompt = $(selectorContent.querySelector('#rebuild_additional_prompt'))
    $selector.empty(); // 로딩 중 상태 초기화

    const temps = USER.tableBaseSetting.rebuild_message_template_list
    // 옵션 추가
    Object.entries(temps).forEach(([key, prompt]) => {

        $selector.append(
            $('<option></option>')
                .val(key)
                .text(prompt.name || key)
        );
    });

    // 기본 선택 항목 설정
    // USER에서 마지막으로 선택한 옵션을 읽어오고, 없으면 기본값 사용
    const defaultTemplate = USER.tableBaseSetting?.lastSelectedTemplate || 'rebuild_base';
    $selector.val(defaultTemplate);
    // 템플릿 정보 표시 업데이트
    if (defaultTemplate === 'rebuild_base') {
        $templateInfo.text("기본 템플릿으로 Gemini, Grok, DeepSeek에 적합하며, 채팅 기록과 테이블 정보를 사용하여 테이블을 재구성함. 초기 양식 작성, 테이블 최적화 등의 시나리오에 적용됨. 제한은 TT 선생님으로부터. ");
    } else {
        const templateInfo = temps[defaultTemplate]?.info || '템플릿 정보 없음';
        $templateInfo.text(templateInfo);
    }

    // 선택기 변화 감지
    $selector.on('change', function () {
        const selectedTemplate = $(this).val();
        const template = temps[selectedTemplate];
        $templateInfo.text(template.info || '템플릿 정보 없음');
    })



    const confirmation = new EDITOR.Popup(container, EDITOR.POPUP_TYPE.CONFIRM, '', {
        okButton: "계속하기",
        cancelButton: "취소"
    });

    await confirmation.show();
    if (confirmation.result) {
        const selectedTemplate = $selector.val();
        const additionalPrompt = $additionalPrompt.val();
        USER.tableBaseSetting.lastSelectedTemplate = selectedTemplate; // 사용자 선택 템플릿 저장
        DERIVED.any.additionalPrompt = additionalPrompt; // 추가 프롬프트 내용 저장
        getPromptAndRebuildTable();
    }
}


// 将tablesData파싱回Table数组
function tableDataToTables(tablesData) {
    return tablesData.map(item => {
        // 强制确保 columns 是数组，且元素为字符串
        const columns = Array.isArray(item.columns)
            ? item.columns.map(col => String(col)) // 强制转换为字符串
            : inferColumnsFromContent(item.content); // 从 content 推断
        return {
            tableName: item.tableName || '이름 없는 테이블',
            columns,
            content: item.content || [],
            insertedRows: item.insertedRows || [],
            updatedRows: item.updatedRows || []
        }
    });
}

function inferColumnsFromContent(content) {
    if (!content || content.length === 0) return [];
    const firstRow = content[0];
    return firstRow.map((_, index) => `열${index + 1}`);
}

/**
* 提取聊天记录获取功能
* 提取最近的chatStairs条聊天记录
* @param {Array} chat - 聊天记录数组
* @param {number} chatStairs - 要提取的聊天记录数量
* @param {boolean} ignoreUserSent - 是否忽略用户发送的消息
* @param {number|null} tokenLimit - 最大token限制，null表示无限制，优先级高于chatStairs
* @returns {string} 提取的聊天记录字符串
*/
async function getRecentChatHistory(chat, chatStairs, ignoreUserSent = false, tokenLimit = 0) {
    let filteredChat = chat;

    // 处理忽略用户发送消息的情况
    if (ignoreUserSent && chat.length > 0) {
        filteredChat = chat.filter(c => c.is_user === false);
    }

    // 有效记录提示
    if (filteredChat.length < chatStairs && tokenLimit === 0) {
        EDITOR.success(`현재 유효 기록 ${filteredChat.length}개, 설정한 ${chatStairs}개보다 적습니다`);
    }

    const collected = [];
    let totalTokens = 0;

    // 从最新记录开始逆序遍历
    for (let i = filteredChat.length - 1; i >= 0; i--) {
        // 格式化消息并清理标签
        const currentStr = `${filteredChat[i].name}: ${filteredChat[i].mes}`
            .replace(/<tableEdit>[\s\S]*?<\/tableEdit>/g, '');

        // 计算Token
        const tokens = await estimateTokenCount(currentStr);

        // 如果是第一条消息且token数超过限制，直接添加该消息
        if (i === filteredChat.length - 1 && tokenLimit !== 0 && tokens > tokenLimit) {
            totalTokens = tokens;
            EDITOR.success(`최근의 채팅 기록 Token 수는 ${tokens}이며, 설정한 ${tokenLimit} 제한을 초과하므로 해당 채팅 기록을 직접 사용합니다.`);
            console.log(`최근의 채팅 기록 Token 수는 ${tokens}이며, 설정한 ${tokenLimit} 제한을 초과하므로 해당 채팅 기록을 직접 사용합니다.`);
            collected.push(currentStr);
            break;
        }

        // Token限制检查
        if (tokenLimit !== 0 && (totalTokens + tokens) > tokenLimit) {
            EDITOR.success(`이번에 전송된 채팅 기록 토큰 수는 약 ${totalTokens}개이며, 총 ${collected.length}개입니다.`);
            console.log(`이번에 전송된 채팅 기록 토큰 수는 약 ${totalTokens}개이며, 총 ${collected.length}개입니다.`);
            break;
        }

        // 업데이트计数
        totalTokens += tokens;
        collected.push(currentStr);

        // 当 tokenLimit 为 0 时，进行聊天记录数量限制检查
        if (tokenLimit === 0 && collected.length >= chatStairs) {
            break;
        }
    }

    // 按时间顺序排열并拼接
    const chatHistory = collected.reverse().join('\n');
    return chatHistory;
}

/**
 * 修复데이블式
 * @param {string} inputText - 输入的文本
 * @returns {string} 修复后的文本
 * */
function fixTableFormat(inputText) {
    try {
        return safeParse(inputText);
    } catch (error) {
        console.error("파싱 실패:", error);
        const popup = new EDITOR.Popup(`스크립트가 반환된 데이터를 구문 분석할 수 없음. 이는 제한 위반 또는 잘못된 출력 형식에 문제가 있기 때문일 수 있음. 반환된 데이터는 다음과 같음：<div>${inputText}</div>`, EDITOR.POPUP_TYPE.CONFIRM, '', { okButton: "확신" });
        popup.show();
        throw new Error('표 데이터를 구문 분석할 수 없음');
    }
}

window.fixTableFormat = fixTableFormat; // 暴露给全局

/**
 * 修改重整理模板
 */
export async function modifyRebuildTemplate() {
    const selectedTemplate = USER.tableBaseSetting.lastSelectedTemplate;
    const sheetConfig = {
        formTitle: "테이블 요약 템플릿 편집",
        formDescription: "요약 시 프롬프트 구조를 설정합니다. $0은 현재 테이블 데이터, $1은 컨텍스트 채팅 기록, $2는 테이블 템플릿[헤더] 데이터, $3은 사용자가 입력한 추가 프롬프트입니다.",
        fields: [
            { label: '템플릿 이름:', type: 'label', text: selectedTemplate },
            { label: '시스템 프롬프트', type: 'textarea', rows: 6, dataKey: 'system_prompt', description: '(제한 해제 내용을 입력하거나 프롬프트 전체 JSON 구조를 직접 입력하세요. 구조를 입력하면 정리 규칙이 무시됩니다)' },
            { label: '요약 규칙', type: 'textarea', rows: 6, dataKey: 'user_prompt_begin', description: '(AI에게 재정리 방법을 설명하는 데 사용됩니다)' },
        ],
    }
    let initialData = null
    if (selectedTemplate === 'rebuild_base')
        return EDITOR.warning('기본 템플릿은 수정할 수 없습니다. 새 템플릿을 만드세요.');
    else
        initialData = USER.tableBaseSetting.rebuild_message_template_list[selectedTemplate]
    const formInstance = new Form(sheetConfig, initialData);
    const popup = new EDITOR.Popup(formInstance.renderForm(), EDITOR.POPUP_TYPE.CONFIRM, '', { okButton: "저장", allowVerticalScrolling: true, cancelButton: "취소" });
    await popup.show();
    if (popup.result) {
        const result = formInstance.result();
        USER.tableBaseSetting.rebuild_message_template_list = {
            ...USER.tableBaseSetting.rebuild_message_template_list,
            [selectedTemplate]: {
                ...result,
                name: selectedTemplate,
            }
        }
        EDITOR.success(`템플릿 수정 "${selectedTemplate}" 성공`);
    }
}
/*         

/**
 * 新建重整理模板
 */
export async function newRebuildTemplate() {
    const sheetConfig = {
        formTitle: "새 테이블 요약 템플릿",
        formDescription: "테이블 요약 시 프롬프트 구조를 설정합니다. $0은 현재 테이블 데이터, $1은 컨텍스트 채팅 기록, $2는 테이블 템플릿[헤더] 데이터, $3은 사용자가 입력한 추가 프롬프트입니다.",
        fields: [
            { label: '템플릿 이름', type: 'text', dataKey: 'name' },
            { label: '시스템 프롬프트', type: 'textarea', rows: 6, dataKey: 'system_prompt', description: '(제한 해제 내용을 입력하거나 프롬프트 전체 JSON 구조를 직접 입력하세요. 구조를 입력하면 정리 규칙이 무시됩니다)' },
            { label: '정리 규칙', type: 'textarea', rows: 6, dataKey: 'user_prompt_begin', description: '(AI에게 재정리 방법을 설명하는 데 사용됩니다)' },
        ],
    }
    const initialData = {
        name: "새 테이블 요약 템플릿",
        system_prompt: USER.tableBaseSetting.rebuild_default_system_message_template,
        user_prompt_begin: USER.tableBaseSetting.rebuild_default_message_template,
    };
    const formInstance = new Form(sheetConfig, initialData);
    const popup = new EDITOR.Popup(formInstance.renderForm(), EDITOR.POPUP_TYPE.CONFIRM, '', { okButton: "저장", allowVerticalScrolling: true, cancelButton: "취소" });
    await popup.show();
    if (popup.result) {
        const result = formInstance.result();
        const name = createUniqueName(result.name)
        result.name = name;
        USER.tableBaseSetting.rebuild_message_template_list = {
            ...USER.tableBaseSetting.rebuild_message_template_list,
            [name]: result
        }
        USER.tableBaseSetting.lastSelectedTemplate = name;
        refreshRebuildTemplate()
        EDITOR.success(`새 템플릿 "${name}" 생성 성공`);
    }
}

/**
 * 创建不重复的名称
 * @param {string} baseName - 基础名称
 */
function createUniqueName(baseName) {
    let name = baseName;
    let counter = 1;
    while (USER.tableBaseSetting.rebuild_message_template_list[name]) {
        name = `${baseName} (${counter})`;
        counter++;
    }
    return name;
}

/**
 * 删除重整理模板
 */
export async function deleteRebuildTemplate() {
    const selectedTemplate = USER.tableBaseSetting.lastSelectedTemplate;
    if (selectedTemplate === 'rebuild_base') {
        return EDITOR.warning('기본 템플릿은 삭제할 수 없습니다.');
    }
    const confirmation = await EDITOR.callGenericPopup('이 템플릿을 삭제하시겠습니까？', EDITOR.POPUP_TYPE.CONFIRM, '', { okButton: "계속하기", cancelButton: "취소" });
    if (confirmation) {
        const newTemplates = {};
        Object.values(USER.tableBaseSetting.rebuild_message_template_list).forEach((template) => {
            if (template.name !== selectedTemplate) {
                newTemplates[template.name] = template;
            }
        });
        USER.tableBaseSetting.rebuild_message_template_list = newTemplates;
        USER.tableBaseSetting.lastSelectedTemplate = 'rebuild_base';
        refreshRebuildTemplate();
        EDITOR.success(`템플릿 "${selectedTemplate}" 삭제 성공`);
    }
}

/**
 * 导出重整理模板
 */
export async function exportRebuildTemplate() {
    const selectedTemplate = USER.tableBaseSetting.lastSelectedTemplate;
    if (selectedTemplate === 'rebuild_base') {
        return EDITOR.warning('기본 템플릿은 내보낼 수 없습니다.');
    }
    const template = USER.tableBaseSetting.rebuild_message_template_list[selectedTemplate];
    if (!template) {
        return EDITOR.error(`템플릿 "${selectedTemplate}"을(를) 찾을 수 없습니다.`);
    }
    const blob = new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedTemplate}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    EDITOR.success(`템플릿 "${selectedTemplate}" 내보내기 성공`);
}

/**
 * 导入重整理模板
 */
export async function importRebuildTemplate() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.style.display = 'none';
    document.body.appendChild(input);

    input.addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file) {
            EDITOR.error('파일을 선택하지 않았습니다');
            return;
        }
        try {
            const text = await file.text();
            const template = JSON.parse(text);
            if (!template.name || !template.system_prompt || !template.user_prompt_begin) {
                throw new Error('유효하지 않은 템플릿 형식입니다');
            }
            const name = createUniqueName(template.name);
            template.name = name;
            USER.tableBaseSetting.rebuild_message_template_list = {
                ...USER.tableBaseSetting.rebuild_message_template_list,
                [name]: template
            };
            USER.tableBaseSetting.lastSelectedTemplate = name;
            refreshRebuildTemplate();
            EDITOR.success(`템플릿 "${name}" 가져오기 성공`);
        } catch (error) {
            EDITOR.error(`가져오기 실패`, error.message, error);
        } finally {
            document.body.removeChild(input);
        }
    });

    input.click();
}

/**
 * 手动触发一次分步填테이블
 */
export async function triggerStepByStepNow() {
    console.log('[Memory Enhancement] Manually triggering step-by-step update...');
    TableTwoStepSummary("manual")
}

/**
 * 执行增量업데이트（可用于普通새로고침和分步总结）
 * @param {string} chatToBeUsed - 要使用的聊天记录, 为空则使用最近的聊天记录
 * @param {string} originTableText - 当前테이블的文本表示
 * @param {Array} referencePiece - 参考用的piece
 * @param {boolean} useMainAPI - 是否使用주 API
 * @param {boolean} silentUpdate - 是否静默업데이트,不显示 작업确认
 * @param {boolean} [isSilentMode=false] - 是否以静默模式运行API调用（不显示加载提示）
 * @returns {Promise<string>} 'success', 'suspended', 'error', or empty
 */
export async function executeIncrementalUpdateFromSummary(
    chatToBeUsed = '',
    originTableText,
    finalPrompt,
    referencePiece,
    useMainAPI,
    silentUpdate = USER.tableBaseSetting.bool_silent_refresh,
    isSilentMode = false
) {
    if (!SYSTEM.lazy('executeIncrementalUpdate', 1000)) return '';

    try {
        DERIVED.any.waitingPiece = referencePiece;
        const separateReadContextLayers = Number($('#separateReadContextLayers').val());
        const contextChats = await getRecentChatHistory(USER.getContext().chat, separateReadContextLayers, true);
        const summaryChats = chatToBeUsed;

        // 获取角色世界书内容
        let lorebookContent = '';
        if (USER.tableBaseSetting.separateReadLorebook && window.TavernHelper) {
            try {
                const charLorebooks = await window.TavernHelper.getCharLorebooks({ type: 'all' });
                const bookNames = [];
                if (charLorebooks.primary) {
                    bookNames.push(charLorebooks.primary);
                }
                if (charLorebooks.additional && charLorebooks.additional.length > 0) {
                    bookNames.push(...charLorebooks.additional);
                }

                for (const bookName of bookNames) {
                    if (bookName) {
                        const entries = await window.TavernHelper.getLorebookEntries(bookName);
                        if (entries && entries.length > 0) {
                            lorebookContent += entries.map(entry => entry.content).join('\n');
                        }
                    }
                }
            } catch (e) {
                console.error('[Memory Enhancement] Error fetching lorebook content:', e);
            }
        }

        let systemPromptForApi;
        let userPromptForApi;

        console.log("[Memory Enhancement] Step-by-step summary: Parsing and using multi-message template string.");
        const stepByStepPromptString = USER.tableBaseSetting.step_by_step_user_prompt;
        let promptMessages;

        try {
            promptMessages = JSON5.parse(stepByStepPromptString);
            if (!Array.isArray(promptMessages) || promptMessages.length === 0) {
                throw new Error("Parsed prompt is not a valid non-empty array.");
            }
        } catch (e) {
            console.error("Error parsing step_by_step_user_prompt string:", e, "Raw string:", stepByStepPromptString);
            EDITOR.error("독립 작성용 프롬프트 형식 오류로 해석할 수 없습니다. 플러그인 설정을 확인해 주세요.", e.message, e);
            return 'error';
        }

        const replacePlaceholders = (text) => {
            if (typeof text !== 'string') return '';
            text = text.replace(/(?<!\\)\$0/g, () => originTableText);
            text = text.replace(/(?<!\\)\$1/g, () => contextChats);
            text = text.replace(/(?<!\\)\$2/g, () => summaryChats);
            text = text.replace(/(?<!\\)\$3/g, () => finalPrompt);
            text = text.replace(/(?<!\\)\$4/g, () => lorebookContent);
            return text;
        };

        // 完整处理消息数组，替换每个消息中的占位符
        const processedMessages = promptMessages.map(msg => ({
            ...msg,
            content: replacePlaceholders(msg.content)
        }));

        // 将处理后的完整消息数组传递给API请求处理함수
        systemPromptForApi = processedMessages;
        userPromptForApi = null; // 在这种情况下，userPromptForApi 不再需要

        console.log("Step-by-step: Prompts constructed from parsed multi-message template and sent as an array.");

        // 打印将要发送到API的最终数据
        if (Array.isArray(systemPromptForApi)) {
            console.log('API-bound data (as message array):', systemPromptForApi);
            const totalContent = systemPromptForApi.map(m => m.content).join('');
            console.log('Estimated token count:', estimateTokenCount(totalContent));
        } else {
            console.log('System Prompt for API:', systemPromptForApi);
            console.log('User Prompt for API:', userPromptForApi);
            console.log('Estimated token count:', estimateTokenCount(systemPromptForApi + (userPromptForApi || '')));
        }

        let rawContent;
        if (useMainAPI) { // Using Main API
            try {
                // If it's step-by-step summary, systemPromptForApi is already the message array
                // Pass the array as the first arg and null/empty as the second for multi-message format
                // Otherwise, pass the separate system and user prompts for normal refresh
                rawContent = await handleMainAPIRequest(
                    systemPromptForApi,
                    null,
                    isSilentMode
                );
                if (rawContent === 'suspended') {
                    EDITOR.info('작업이 취소되었습니다 (주API)');
                    return 'suspended';
                }
            } catch (error) {
                console.error('주 API 요청 오류:', error);
                EDITOR.error('주 API 요청 오류: ' , error.message, error);
                return 'error';
            }
        } else { // Using Custom API
            try {
                rawContent = await handleCustomAPIRequest(systemPromptForApi, userPromptForApi, true, isSilentMode);
                if (rawContent === 'suspended') {
                    EDITOR.info('작업이 취소되었습니다 (사용자 정의 API)');
                    return 'suspended';
                }
            } catch (error) {
                EDITOR.error('사용자 정의 API 요청 오류: ' , error.message, error);
                return 'error';
            }
        }

        if (typeof rawContent !== 'string' || !rawContent.trim()) {
            EDITOR.error('API 응답 내용이 유효하지 않거나 비어 있습니다.');
            return 'error';
        }

        // **核心修复**: 使用与常规填테이블完全一致的 getTableEditTag 함수来提取指令
        const { matches } = getTableEditTag(rawContent);

        if (!matches || matches.length === 0) {
            EDITOR.info("AI가 유효한 <tableEdit> 작업 지시어를 반환하지 않았습니다. 테이블 내용이 변경되지 않았습니다.");
            return 'success';
        }

        try {
            // 将提取到的、未经修改的原始指令数组传递给执行器
            executeTableEditActions(matches, referencePiece)
        } catch (e) {
            EDITOR.error("테이블 작업 지시어를 실행하는 중 오류 발생: ", e.message, e);
            console.error("오류 원문: ", matches.join('\n'));
        }
        USER.saveChat()
        BASE.refreshContextView();
        updateSystemMessageTableStatus();
        EDITOR.success('독립 프롬프트 완료!');
        return 'success';

    } catch (error) {
        console.error('증분 업데이트 실행 중 오류 발생:', error);
        EDITOR.error(`증분 업데이트 실행 실패`, error.message, error);
        console.log('[Memory Enhancement Plugin] Error context:', {
            timestamp: new Date().toISOString(),
            error: error.message,
            stack: error.stack,
        });
        return 'error';
    }
}
