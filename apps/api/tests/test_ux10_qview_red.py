"""UX10 question viewer option-order contract."""

from quiz_api.api.practice import PracticeSessionCreate


def test_ux10_qview_ac01_option_shuffle_is_explicitly_opt_in() -> None:
    assert PracticeSessionCreate().shuffle_options is False
    assert PracticeSessionCreate(shuffle_options=True).shuffle_options is True
