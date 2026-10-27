"""Manual real DSH SDK profile -> codex2api -> Codex tool integration check."""
import json
import os
from pathlib import Path
import sys

repo = Path(os.environ.get('DSH_REPO', r'D:\dev\deepseek-harness-windows'))
sys.path.insert(0, str(repo / 'python/sdk/src'))
from deepseek_harness import DeepSeekHarness

root = Path(__file__).resolve().parents[1]
home = root / 'data/dsh-tools-smoke'
workspace = home / 'workspace'
workspace.mkdir(parents=True, exist_ok=True)
(workspace / 'client-only-proof.txt').write_text('DSH_CLIENT_EXECUTION_67291', encoding='utf8')
skill_dir = workspace / 'skills/codex2api-proof'
skill_dir.mkdir(parents=True, exist_ok=True)
(skill_dir / 'SKILL.md').write_text('---\nname: codex2api-proof\ndescription: Read-only codex2api integration proof skill.\n---\nReport DSH_SKILL_PROOF_8142 when asked to load this skill.\n', encoding='utf8')
patch = home / 'tools.patch.yml'
base_url = os.environ.get('TEST_BASE_URL', 'http://127.0.0.1:3011').rstrip('/')
patch.write_text('''
- id: llm-pi-ai
  config:
    providers:
      codex2api:
        apiKeyEnv: CODEX2API_SMOKE_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:3011/v1
        models:
          - id: gpt-6.1-sol
            contextWindow: 262144
        retryPolicy:
          mode: normal
          maxRetries: 0
- id: tool-plugin-manager
  disabled: false
- insert:
    - id: codex2api-cordis-runner
      name: '@deepseek-ai/dsh-cordis-host-runner'
    - id: codex2api-cordis-host
      name: '@deepseek-ai/dsh-tool-cordis/host'
    - id: codex2api-cordis-tools
      name: '@deepseek-ai/dsh-tool-cordis'
'''.replace('http://127.0.0.1:3011', base_url) + '\n- id: skill-filesystem\n  config:\n    customSkillDirs:\n      - ' + json.dumps(str(workspace / 'skills')) + '\n', encoding='utf8')
with DeepSeekHarness(
    provider='codex2api', model='gpt-6.1-sol', cwd=str(workspace),
    runtime_cwd=str(repo), dsh_home=str(home),
    _launch_args=('node', '--import', 'tsx/esm', str(repo / 'apps/cli/src/bin.ts'), '--profile', 'sdk', '--patch', str(patch)),
    env={'DSH_HOME': str(home), 'DSH_TELEMETRY_DISABLED': '1', 'CODEX2API_SMOKE_KEY': os.environ.get('API_KEY', 'local-smoke')},
    request_timeout_seconds=180,
) as harness:
    result = harness.run('Load the codex2api-proof skill using skill. Use read to read client-only-proof.txt in the current workspace. Then call cordis_inspect_list and use one of its declared read-only host methods with cordis_inspect_query. Also call plugin_manager with a read-only list/status operation, using its documented schema. Do not install or change anything. Return the exact file contents and skill proof and briefly confirm the inspection outcomes.', session_id='codex2api-tools-' + os.urandom(4).hex())
    # Durable DSH events contain the actual locally executed calls and results.
    (home / 'result.json').write_text(json.dumps({'final': result.final_response, 'events': result.events}, ensure_ascii=False, indent=2), encoding='utf8')
    print(result.final_response)
    print('DSH evidence:', home / 'result.json')
    assert 'DSH_CLIENT_EXECUTION_67291' in result.final_response
    calls = {event['data']['name'] for event in result.events if event.get('type') == 'tool/call'}
    assert {'skill', 'read', 'cordis_inspect_list', 'cordis_inspect_query', 'plugin_manager'} <= calls, calls
    assert 'DSH_SKILL_PROOF_8142' in result.final_response
    print('Verified DSH tool/call events:', ', '.join(sorted(calls)))
