"""The cookbook manifest — the Python twin of
``clients/sdk-cookbook/src/manifest.ts``, one entry per TS recipe, in the
same ratified numeric order. PY-TEST-021 discovers the TS recipe set from
the TS tree and reds a missing twin here (never a count).
"""

from __future__ import annotations

from .recipes.answer_user_input import RECIPE as answer_user_input
from .recipes.approve_or_deny import RECIPE as approve_or_deny
from .recipes.cancel_mid_turn import RECIPE as cancel_mid_turn
from .recipes.classify_serve_exits import RECIPE as classify_serve_exits
from .recipes.fingerprint_mismatch import RECIPE as fingerprint_mismatch
from .recipes.list_models_and_switch_mid_session import (
    RECIPE as list_models_and_switch_mid_session,
)
from .recipes.queue_steer_reclaim import RECIPE as queue_steer_reclaim
from .recipes.resume_and_verify import RECIPE as resume_and_verify
from .recipes.retry_without_double_submitting import (
    RECIPE as retry_without_double_submitting,
)
from .recipes.stream_a_turn import RECIPE as stream_a_turn
from .recipes.survive_the_host_dying import RECIPE as survive_the_host_dying
from .runner import Recipe

RECIPES: tuple[Recipe, ...] = (
    stream_a_turn,
    approve_or_deny,
    cancel_mid_turn,
    resume_and_verify,
    survive_the_host_dying,
    fingerprint_mismatch,
    classify_serve_exits,
    list_models_and_switch_mid_session,
    retry_without_double_submitting,
    answer_user_input,
    queue_steer_reclaim,
)
